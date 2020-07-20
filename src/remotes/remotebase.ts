
import {Z80RegistersClass, Z80_REG, Z80Registers} from './z80registers';
import {RefList} from '../misc/refList';
import {CallStackFrame} from '../callstackframe';
import {EventEmitter} from 'events';
import {GenericWatchpoint, GenericBreakpoint} from '../genericwatchpoint';
import {Labels, SourceFileEntry} from '../labels';
import {Settings, ListFile} from '../settings';
import {Utility} from '../misc/utility';
import {BaseMemory} from '../disassembler/basememory';
import {Opcode, OpcodeFlag} from '../disassembler/opcode';
import {CpuHistory, StepHistory} from './cpuhistory';
import {Disassembly, DisassemblyClass} from '../misc/disassembly';




/**
 * Breakpoint reason numbers.
 * Are used in DZRP as well, so be cautious when changing values.
 */
export enum BREAK_REASON_NUMBER {
	NO_REASON=0,		// 0=no break reason (e.g.a step-over)
	MANUAL_BREAK=1,		// 1=User (manual) break
	BREAKPOINT_HIT=2,	// 2=breakpoint hit
	WATCHPOINT_READ=3,	// 3=watchpoint hit read access
	WATCHPOINT_WRITE=4,	// 4=watchpoint hit write access
	UNKNOWN = 255		// 255=some other error
};


/**
 * The breakpoint representation.
 */
export interface RemoteBreakpoint extends GenericBreakpoint {
	bpId: number;	///< The breakpoint ID/number (>0). Mandatory.
	filePath?: string;	///< The file to which the breakpoint belongs
	lineNr: number;	///< The line number in the file starting at 0
	// Already defined: address: number;	///< Usually the pc value to stop at (e.g. 0x0A7F)
	// Already defined: condition?: string;	///< An additional condition.
	// Already defined: log?: string;	///< An optional log message. If set the execution will not stop at the breakpoint but a log message is written instead.
}



/// Definition of one memory bank, i.e. memory slot/bank relationship.
export interface MemoryBank {
	/// Z80 start address of page.
	start: number;

	/// Z80 end address of page.
	end: number;

	/// The name of the mapped memory area.
	name: string;
};


/**
 * The Remote's base class.
 * It implements, provides stubs or interfaces to deal with:
 * - step, run (continue), etc.
 * - reverse debugging
 * - breakpoints
 *
 * Breakpoints:
 * The 'breakpoints' array contains all breakpoints set by the
 * vscode UI. I.e. the breakpoints you set manually/the red dot
 * at the start of the line.
 * vscode sends a setBreakPointsRequest with the breakpoints, they
 * are converted into the RemoteBreakpoint type and set with
 * setBreakPoints. The Remote will now compare the breakpoints with the internal
 * 'breakpoints' array and set/remove all changed breakpoints.
 *
 * The additional 'watchpoints', 'assertBreakpoints' and 'logpoints'
 * arrays can be enabled/disabled as a group via a debug command.
 * - 'watchPoints': These are associated with the WPMEM keyword and create
 * a memory watchpoint (a breakpoint that is hit if a memory adress is
 * accessed).
 * - 'assertBreakpoints': These are very much like conditional breakpoints but associated with the ASSERT keyword.
 * - 'logpoints': These are just like breakpoints with a log message but associated with the LOGPOINT keyword.
 * Note: The attached emulator may use the same mechanism for all these
 * kinds of breakpoints but in DeZog they are differentiated.
 *
 */
export class RemoteBase extends EventEmitter {

	// Maximum stack items to handle.
	static MAX_STACK_ITEMS=100;

	/// The top of the stack. Used to limit the call stack.
	public topOfStack: number;

	/// A list for the frames (call stack items). Is cached here.
	protected listFrames: RefList<CallStackFrame>;

	/// Mirror of the remote's breakpoints.
	protected breakpoints=new Array<RemoteBreakpoint>();

	/// The WPMEM watchpoints can only be enabled/disabled alltogether.
	public wpmemEnabled=false;

	/// The virtual stack used during reverse debugging.
	protected reverseDbgStack: RefList<CallStackFrame>;

	/// Stores the wpmem watchpoints (this is a smaller list, if watchpoints can be given manually)
	protected wpmemWatchpoints=new Array<GenericWatchpoint>();

	/// Stores the assert breakpoints
	protected assertBreakpoints=new Array<GenericBreakpoint>();

	/// The assert breakpoints can only be enabled/disabled alltogether.
	public assertBreakpointsEnabled=false;

	/// Stores the log points
	protected logpoints=new Map<string, Array<GenericBreakpoint>>();

	/// The logpoints can be enabled/disabled per group.
	public logpointsEnabled=new Map<string, boolean>();

	/// In which slot,subslot,bank/segment the PC should be for an OpenMSX debug session
	protected pcInSlot:string="";


	/// Constructor.
	/// Override this.
	constructor() {
		super();
	}


	/// Initializes the machine.
	/// When ready it emits this.emit('initialized') or this.emit('error', exception);
	/// Don't override this, override 'doInitialization' instead.
	/// Take care to implement the emits otherwise the system will hang on a start.
	public async init(): Promise<void> {
		// Call custom initialization
		await this.doInitialization();
	}


	/// Do initialization.
	/// E.g. create a socket or allocate memory.
	/// This is called when the Remote is started by the debugger. I.e. at the start
	/// of a debugging session..
	/// When ready do a this.emit('initialized') or this.emit('error', exception);
	/// Take care to implement the emits otherwise the system will hang on a start.
	/// Please override.
	public async doInitialization(): Promise<void> {
	}


	/**
	 * Creates an array of watch points from the text lines.
	 * @param watchPointLines An array with address and line (text) pairs.
	 * @return An array with watch points (GenericWatchpoints).
	 */
	protected createWatchPoints(watchPointLines: Array<{address: number, line: string}>): Array<GenericWatchpoint> {
		// convert labels in watchpoints.
		const watchpoints=new Array<GenericWatchpoint>();

		let i=-1;
		for (let entry of watchPointLines) {
			i=i+1;
			// WPMEM:
			// Syntax:
			// WPMEM [addr [, length [, access]]]
			// with:
			//	addr = address (or label) to observe (optional). Defaults to current address.
			//	length = the count of bytes to observe (optional). Default = 1.
			//	access = Read/write access. Possible values: r, w or rw. Defaults to rw.
			// e.g. WPMEM LBL_TEXT, 1, w
			// or
			// WPMEM ,1,w, MWV&B8h/0

			try {
				// Now check more thoroughly: group1=address, group3=length, group5=access, group7=condition
				const match=/;\s*WPMEM(?=[,\s]|$)\s*([^\s,]*)?(\s*,\s*([^\s,]*)(\s*,\s*([^\s,]*)(\s*,\s*([^,]*))?)?)?/.exec(entry.line);
				if (match) {
					// get arguments
					let addressString=match[1];
					let lengthString=match[3];
					let access=match[5];
					let cond=match[7];	// This is supported only with "fast-breakpoints" not with the unmodified ZEsarUX. Also the new (7.1) faster memory breakpoints do not support conditions.
					// defaults
					let entryAddress: number|undefined=entry.address;
					if (addressString&&addressString.length>0)
						entryAddress=Utility.evalExpression(addressString, false); // don't evaluate registers
					if (isNaN(entryAddress))
						continue;	// could happen if the WPMEM is in an area that is conditionally not compiled, i.e. label does not exist.
					let length=1;
					if (lengthString&&lengthString.length>0) {
						length=Utility.evalExpression(lengthString, false); // don't evaluate registers
					}
					else {
						if (!addressString||addressString.length==0) {
							// If both, address and length are not defined it is checked
							// if there exists bytes in the list file (i.e.
							// numbers after the address field).
							// If not the "WPMEM" is assumed to be inside a
							// macro and omitted.
							const match=/^[0-9a-f]+\s[0-9a-f]+/i.exec(entry.line);
							if (!match)
								continue;
						}
					}
					if (access&&access.length>0) {
						if (access!='r'&&access!='w'&&access!='rw') {
							console.log("Wrong access mode in watch point. Allowed are only 'r', 'w' or 'rw' but found '"+access+"' in line: '"+entry.line+"'");
							continue;
						}
					}
					else
						access='rw';
					// set watchpoint
					watchpoints.push({address: entryAddress, size: length, access: access, condition: cond||''});
				}
			}
			catch (e) {
				throw "Problem with WPMEM. Could not evaluate: '"+entry.line+"': "+e+"";
			}
		}

		return watchpoints;
	}


	/**
	 * Creates an array of asserts from the text lines.
	 * @param watchPointLines An array with address and line (text) pairs.
	 * @return An array with asserts (GenericWatchpoints).
	 */
	protected createAsserts(assertLines: Array<{address: number, line: string}>) {
		const assertMap=new Map<number, GenericBreakpoint>();
		// Convert ASSERTS to watchpoints
		for (let entry of assertLines) {
			// ASSERT:
			// Syntax:
			// ASSERT var comparison expr [&&|| expr]
			// with:
			//  var: a variable, i.e. a register like A or HL
			//  comparison: one of '<', '>', '==', '!=', '<=', '=>'.
			//	expr: a mathematical expression that resolves into a constant
			// Examples:
			// - ASSERT A < 5
			// - ASSERT HL <= LBL_END+2
			// - ASSERT B > (MAX_COUNT+1)/2

			// ASSERTs are breakpoints with "inverted" condition.
			// Now check more thoroughly: group1=var, group2=comparison, group3=expression
			try {
				const matchAssert=/;.*\bASSERT\b/.exec(entry.line);
				if (!matchAssert) {
					// Eg. could be that "ASSERTx" was found.
					continue;
				}

				// Get part of the string after the "ASSERT"
				const part=entry.line.substr(matchAssert.index+matchAssert[0].length).trim();

				// Check if no condition was set = ASSERT false = Always break
				let conds='';
				if (part.length>0) {
					// Some condition is set
					const regex=/\s*([^;]*)/i;
					let match=regex.exec(part);
					if (!match)	// At least one match should be found
						throw "Expecting 'ASSERT expr'.";
					conds=match[1];
				}

				// Negate the expression
				conds=Utility.getConditionFromAssert(conds);

				// Check if ASSERT for that address already exists.
				if (conds.length>0) {
					let bp=assertMap.get(entry.address);
					if (bp) {
						// Already exists: just add condition.
						bp.condition='('+bp.condition+') || ('+conds+')';
					}
					else {
						// Breakpoint for address does not yet exist. Create a new one.
						const assertBp={address: entry.address, condition: conds, log: undefined};
						assertMap.set(entry.address, assertBp);
					}
				}
			}
			catch (e) {
				console.log("Problem with ASSERT. Could not evaluate: '"+entry.line+"': "+e+"");
			}
		}

		// Convert map to array.
		const assertsArray=Array.from(assertMap.values());

		return assertsArray;
	}


	/**
	 * Creates an array of log points from the text lines.
	 * @param watchPointLines An array with address and line (text) pairs.
	 * @return An array with log points (GenericWatchpoints).
	 */
	protected createLogPoints(watchPointLines: Array<{address: number, line: string}>): Map<string, Array<GenericBreakpoint>> {
		// convert labels in watchpoints.
		const logpoints=new Map<string, Array<GenericBreakpoint>>();
		for (let entry of watchPointLines) {
			// LOGPOINT:
			// Syntax:
			// LOGPOINT [group] text ${(var):signed} text ${reg:hex} text ${w@(reg)} text ¢{b@(reg):unsigned}
			// e.g. LOGPOINT [SPRITES] Status=${A}, Counter=${(sprite.counter):unsigned}

			// Now check more thoroughly i.e. for comma
			const match=/;.*LOGPOINT\s(\s*\[\s*(\w*)\s*\]\s)?(.*)$/.exec(entry.line);
			if (match) {
				// get arguments
				const group=match[2]||"DEFAULT";
				const logMsg='['+group+'] '+match[3];
				// Create group if not existent
				let array=logpoints.get(group);
				if (!array) {
					array=new Array<GenericBreakpoint>();
					logpoints.set(group, array);
				}
				// Convert labels
				try {
					const log=this.evalLogMessage(logMsg);
					// set watchpoint
					array.push({address: entry.address, condition: '', log: log});
				}
				catch (e) {
					// Show error
					console.log("Problem with LOGPOINT. Could not evaluate: '"+entry.line+"': "+e+"");
				}
			}
		}

		return logpoints;
	}


	/**
	 * Evaluates a log message, i.e. a message that was given for a logpoint.
	 * The format is checked and also the labels are changed into numbers.
	 * Throws an exception in case of a formatting error.
	 * @param logMsg A message in log format, e.g. "Status=${w@(status_byte):unsigned}"
	 * @returns The converted string. I.e. label names are converted to numbers.
	 */
	public evalLogMessage(logMsg: string|undefined): string|undefined {
		if (!logMsg)
			return undefined

		// Search all "${...}""
		const result=logMsg.replace(/\${\s*(.*?)\s*}/g, (match, inner) => {
			// Check syntax
			const matchInner=/(([bw]@)?\s*\(\s*(.*?)\s*\)|(\w*)\s*)\s*(:\s*(unsigned|signed|hex))?\s*/i.exec(inner);
			if (!matchInner)
				throw "Log message format error: '"+match+"' in '"+logMsg+"'";
			const end=(matchInner[6])? ':'+matchInner[6]:'';
			let addr=matchInner[3]||'';
			if (addr.length) {
				const access=matchInner[2]||'';
				// Check if it is a register
				if (Z80RegistersClass.isRegister(addr)) {
					// e.g. addr == "HL" in "(HL)"
					return "${"+access+"("+addr+")"+end+"}";
				}
				else {
					// Check variable for label
					try {
						//console.log('evalLogMessage: ' + logMsg + ': ' + addr);
						const converted=Utility.evalExpression(addr, false);
						return "${"+access+"("+converted.toString()+")"+end+"}";
					}
					catch (e) {
						// If it cannot be converted (e.g. a register name) an exception will be thrown.
						throw "Log message format error: "+e.message+" in '"+logMsg+"'";
					}
				}
			}
			else {
				// Should be a register (Note: this is not 100% fool proof since there are more registers defined than allowed in logs)
				const reg=matchInner[4];
				if (!Z80RegistersClass.isRegister(reg))
					throw "Log message format error: Unsupported register '"+reg+"' in '"+logMsg+"'";
				return "${"+reg+end+"}";
			}
		});

		console.log('evalLogMessage: '+result);
		return result;
	}


	/**
	 * Reads the list file and also retrieves all occurrences of
	 * WPMEM, ASSERT and LOGPOINT.
	 * Also sets WPMEM, ASSERT and LOGPOINT break/watchpoints.
	 * May throw an error.
	 * @param listFiles An array with all list files.
	 * @param sources An array with directories where the source files are located.
	 */
	public readListFiles(listFiles: Array<ListFile>) {
		// Array for found watchpoints: WPMEM, ASSERT breakpoints, LOGPOINT watchpoints
		const watchPointLines=new Array<{address: number, line: string}>();
		const assertLines=new Array<{address: number, line: string}>();
		const logPointLines=new Array<{address: number, line: string}>();
		// Load user list and labels files
		for (const listFile of listFiles) {
			const file={
				path: Utility.getAbsFilePath(listFile.path),
				mainFile: listFile.mainFile,
				srcDirs: listFile.srcDirs||[""],
				filter: listFile.filter,
				asm: listFile.asm||"sjasmplus",
				addOffset: listFile.addOffset||0,
				z88dkMapFile: listFile.z88dkMapFile
			};
			this.pcInSlot = listFile.pcInSlot;
			Labels.loadAsmListFile(file.path, file.mainFile, file.srcDirs, file.filter, file.asm, file.addOffset, (address, line) => {
				// Quick search for WPMEM
				if (line.indexOf('WPMEM')>=0) {
					// Add watchpoint at this address
					watchPointLines.push({address: address, line: line});
				}
				// Quick search for ASSERT
				if (line.indexOf('ASSERT')>=0) {
					// Add assert line at this address
					assertLines.push({address: address, line: line});
				}
				// Quick search for LOGPOINT
				if (line.indexOf('LOGPOINT')>=0) {
					// Add assert line at this address
					logPointLines.push({address: address, line: line});
				}
			}, file.z88dkMapFile);
		}

		// Finishes off the loading of the list and labels files
		Labels.finish();

		// calculate top of stack, execAddress
		this.topOfStack=Labels.getNumberFromString(Settings.launch.topOfStack);
		if (isNaN(this.topOfStack))
			throw Error("Cannot evaluate 'topOfStack' ("+Settings.launch.topOfStack+").");

		// Set watchpoints (memory guards)
		const watchpoints=this.createWatchPoints(watchPointLines);
		this.setWPMEMArray(watchpoints);

		// ASSERTs
		// Set assert breakpoints
		const assertsArray=this.createAsserts(assertLines);
		this.setASSERTArray(assertsArray);

		// LOGPOINTs
		const logPointsMap=this.createLogPoints(logPointLines);
		this.setLOGPOINTArray(logPointsMap);
	}


	/**
	 * Stops a remote.
	 * This will e.g. disconnect the socket and un-use all data.
	 * Called e.g. when vscode sends a disconnectRequest
	 * Very much like 'terminate' but does not send the 'terminated' event.
	 */
	public async disconnect(): Promise<void> {
		// please override.
	}


	/**
	 * Terminates the remote.
	 * This should disconnect the socket and un-use all data.
	 * Called e.g. when the unit tests want to terminate the emulator or on a 'restartRequest'.
	 * Emits the "this.emit('terminated')".
	 * No need to override.
	 */
	public async terminate(): Promise<void> {
		await this.disconnect();
		this.emit('terminated');
	}


	/**
	* Gets the registers from cache. If cache is empty retrieves the registers from
	* the emulator.
    * Override.
	*/
	public async getRegisters(): Promise<void> {
		Utility.assert(false);
	}


	/**
	 * Returns the PC value.
	 */
	public getPC(): number {
		return Z80Registers.getRegValueByName("PC");
	}


	/**
	 * Returns a specific register value.
	 * Note: The registers should already be present (cached).
	 * I.e. there is no communication with the remote emulator involved.
	 * @param register The register to return, e.g. "BC" or "A'". Note: the register name has to exist. I.e. it should be tested before.
	 */
	public getRegisterValue(register: string): number {
		const value=Z80Registers.getRegValueByName(register);
		return value;
	}


	/**
	 * Returns all registers with the given value.
	 * Is used to find registers that match a certain address. (Hovering)
	 * @param value The value to find.
	 * @returns An array of strings with register names that match. If no matching register is found returns an empty array.
	 */
	public getRegistersEqualTo(value: number): Array<string> {
		let resRegs: Array<string>=[];
		if (Z80Registers.valid()) {
			const regs=["HL", "DE", "IX", "IY", "SP", "BC", "HL'", "DE'", "BC'"];
			resRegs=regs.filter(reg => value==Z80Registers.getRegValueByName(reg));
		}
		return resRegs;
	}


	/**
	 * Returns the 'letiable' formatted register value.
	 * @param reg The name of the register, e.g. "A" or "BC"
	 * @returns The formatted string.
	 */
	public getVarFormattedReg(reg: string): string {
		return Z80Registers.getVarFormattedReg(reg);
	}


	/**
	 * Returns the 'hover' formatted register value.
	 * @param reg The name of the register, e.g. "A" or "BC"
	 * @returns The formatted string.
	 */
	public getHoverFormattedReg(reg: string): string {
		return Z80Registers.getHoverFormattedReg(reg);
	}


	/**
	 * Sets the value for a specific register.
	 * Reads the value from the emulator and returns it in the promise.
	 * Note: if in reverse debug mode the function should do nothing and the promise should return the previous value.
	 * @param register The register to set, e.g. "BC" or "A'". Note: the register name has to exist. I.e. it should be tested before.
	 * @param value The new register value.
	 * @return Promise with the "real" register value.
	 */
	public async setRegisterValue(register: string, value: number): Promise<number> {
		Utility.assert(false);	// override this
		return 0;
	}


	/**
	 * Checks the stack entry type for the given value.
	 * If the type is CALL, RST (or interrupt) an object with the label name, the called and
	 * the caller address is returned.
	 * Otherwise an undefined object is returned.
	 * @param stackEntryValue E.g. "3B89"
	 * @returns {name, callerAddr}
	 * if there was a CALL or RST
	 * - name: The label name or the hex string of the called address
	 * - callerAddr: The caller address of the subroutine
	 * Otherwise undefined.
	 */
	protected async getStackEntryType(stackEntryValue: string): Promise<{name: string, callerAddr: number}|undefined> {
		// Get the 3 bytes before address.
		const addr=parseInt(stackEntryValue, 16);
		const data=await this.readMemoryDump(addr-3, 3);
		let calledAddr;
		let callerAddr;
		// Check for Call
		const opc3=data[0];	// get first of the 3 bytes
		if (opc3==0xCD	// CALL nn
			||(opc3&0b11000111)==0b11000100) 	// CALL cc,nn
		{
			// It was a CALL, get address.
			calledAddr=(data[2]<<8)+data[1];
			callerAddr=addr-3;
		}
		else {
			/*
			I removed the check for RST:
			An RST will happen relatively seldom. But here a RST would be found with
			a probability of 1/16. I.e. every 16th value would be wrong.
			Therefore I better skip the detection.

			// Check if one of the 2 last bytes was a RST.
			// Note: Not only the last byte is checked but also the byte before. This is
			// a small "hack" to allow correct return addresses even for esxdos.
			let opc12=(data[1]<<8)+data[2];	// convert both opcodes at once

			let k=1;
			while (opc12!=0) {
				if ((opc12&0b11000111)==0b11000111)
					break;
				// Next
				opc12>>>=8;
				k++;
			}
			if (opc12!=0) {
				// It was a RST, get p
				calledAddr=opc12&0b00111000;
				callerAddr=addr-k;
			}
			*/
		}

		// Nothing found?
		if (calledAddr==undefined) {
			return undefined;
		}

		// Found: get label
		const labelCalledAddrArr=Labels.getLabelsForNumber(calledAddr);
		const labelCalledAddr=(labelCalledAddrArr.length>0)? labelCalledAddrArr[0]:Utility.getHexString(calledAddr, 4)+'h';

		// Return
		return {name: labelCalledAddr, callerAddr};
	}


	/**
	* Returns the stack as an array.
	* Oldest element is at index 0.
	* @returns The stack, i.e. the word values from topOfStack to SP.
	* But no more than about 100 elements.
    * The values are returned as hex string, an additional info might follow.
	* This is e.g. used for the ZEsarUX extended stack info.
	*/
	public async getStack(): Promise<Array<string>> {
		await this.getRegisters();
		const sp=Z80Registers.getSP();
		// calculate the depth of the call stack
		const tos=this.topOfStack;
		var depth=tos-sp; // 2 bytes per word
		if (depth>2*RemoteBase.MAX_STACK_ITEMS) depth=2*RemoteBase.MAX_STACK_ITEMS;

		// Check if callstack need to be called
		const zStack: Array<string>=[];
		if (depth>0) {
			// Get stack
			const data=await this.readMemoryDump(sp, depth);

			// Create stack
			for (let i=depth-2; i>=0; i-=2) {
				const value=(data[i+1]<<8)+data[i];
				zStack.push(Utility.getHexString(value, 4));
			}
		}
		return zStack;
	}


	/**
	 * Clears the callstack.
	 * The next call to 'getCallStack' will not return the cached value,
	 * but will reload the cache.
	 */
	public clearCallStack() {
		this.listFrames=undefined as any;
	}


	/**
	 * Returns the stored call stack.
	 */
	/*
	public getCallStackCache(): RefList<CallStackFrame> {
		return this.listFrames;
	}
	*/


	/**
	  * Returns the extended stack as array.
	  * Oldest element is at index 0.
	  * The extended stack .......
	  * @returns The stack, i.e. the word values from SP to topOfStack.
	  * But no more than about 100 elements.
	  */
	public async getCallStack(): Promise<RefList<CallStackFrame>> {
		// Check if there are already cached values.
		if (this.listFrames)
			return this.listFrames;

		const callStack=new RefList<CallStackFrame>();
		// Get normal stack values
		const stack=await this.getStack();
		// Start with main
		const sp=Z80Registers.getRegValue(Z80_REG.SP);
		const len=stack.length;
		const top=sp+2*len;
		let lastCallStackFrame=new CallStackFrame(0, top-2, this.getMainName(top));
		callStack.addObject(lastCallStackFrame);

		// Check for each value if it maybe is a CALL or RST
		for (let i=0; i<len; i++) {
			const valueString=stack[i];
			const type=await this.getStackEntryType(valueString);
			if (type) {
				// Set caller address
				lastCallStackFrame.addr=type.callerAddr;
				// CALL, RST or interrupt
				const frameSP=top-2-2*(i+1);
				lastCallStackFrame=new CallStackFrame(0, frameSP, type.name);
				callStack.addObject(lastCallStackFrame);
			}
			else {
				// Something else, e.g. pushed value
				lastCallStackFrame.stack.push(parseInt(valueString,16));
			}
		}

		// Set PC
		const pc=Z80Registers.getRegValue(Z80_REG.PC);
		lastCallStackFrame.addr=pc;

		// Return
		this.listFrames=callStack;
		return callStack;
	}


	/**
	 * Returns the name of the interrupt.
	 */
	public getInterruptName() {
		return "__INTERRUPT__";
	}


	/**
	 * Returns the name of the main function.
	 * @param sp The current SP value.
	 * @returns E.g. "__MAIN__" or "__MAIN-2__" if main is not at topOfStack.
	 */
	public getMainName(sp: number) {
		let part="";
		if (this.topOfStack) {
			const diff=this.topOfStack-sp;
			if (diff!=0) {
				if (diff>0)
					part="+";
				part+=diff.toString();
			}
		}
		return "__MAIN"+part+"__";
	}


	/**
	 * Returns the stack frames.
	 * Either the "real" ones from Remote or the virtual ones during reverse debugging.
	 * @returns A Promise with an array with call stack frames.
	 */
	public async stackTraceRequest(): Promise<RefList<CallStackFrame>> {
		// Check for reverse debugging.
		if (CpuHistory.isInStepBackMode()) {
			// Return virtual stack
			Utility.assert(this.reverseDbgStack);
			return this.reverseDbgStack;
		}
		else {
			// "real" stack trace
			const callStack=await this.getCallStack();
			return callStack;
		}
	}


	/**
	 * @param ref The reference number to the frame.
	 * @returns The associated frame or undefined.
	 */
	public getFrame(ref: number): CallStackFrame|undefined {
		const frame=this.listFrames.getObject(ref);
		return frame;
	}


	/**
	 * 'continue' debugger program execution.
	 * @returns A Promise with a string.
	 * Is called when it's stopped e.g. when a breakpoint is hit.
	 * reason contains the stop reason as string.
	 */
	public async continue(): Promise<string> {
		Utility.assert(false);	// override this
		return '';
	}


	/**
	 * 'pause' the debugger.
	 */
	public async pause(): Promise<void> {
		Utility.assert(false);	// override this
	}


	/**
	 * 'reverse continue' debugger program execution.
	 * The Promise resolves when it's stopped e.g. when a breakpoint is hit.
	 * @returns A string with the break reason. (Never undefined)
	 */
	public async reverseContinue(): Promise<string> {
		Utility.assert(false);	// override this
		return "";
	}


	/**
	 * 'step over' an instruction in the debugger.
	 * @returns A Promise with:
	 * 'instruction' is the disassembly of the current line.
	 * 'breakReasonString' a possibly text with the break reason.
	 */
	public async stepOver(): Promise<{instruction: string, breakReasonString?: string}> {
		Utility.assert(false);	// override this
		return {
			instruction: ""
		};
	}


	/**
	 * 'step into' an instruction in the debugger.
	 * @returns A Promise:
	 * 'instruction' is the disassembly of the current line.
	 * 'breakReasonString' a possibly text with the break reason. This is mainly to keep the
	 * record consistent with stepOver. But it is e.g. used to inform when the
	 * end of the cpu history is reached.
	 */
	public async stepInto(): Promise<{instruction: string,breakReasonString?: string}> {
		Utility.assert(false);	// override this
		return {
			instruction: ""
		};
	}


	/**
	 * 'step out' of current subroutine.
	 * @returns A Promise with a string containing the break reason.
	 * 'breakReasonString' a possibly text with the break reason.
	 */
	public async stepOut(): Promise<string> {
		Utility.assert(false);	// override this
		return '';
	}


	/**
	 * Sets the watchpoint array.
	 * @param watchPoints A list of addresses to put a guard on.
	 */
	public setWPMEMArray(watchPoints: Array<GenericWatchpoint>) {
		this.wpmemWatchpoints=[...watchPoints];
	}


	/**
	 * Enables/disables all WPMEM watchpoints set from the sources.
	 * Promise is called when method finishes.
	 * @param enable true=enable, false=disable.
	 */
	public async enableWPMEM(enable: boolean): Promise<void> {
		for (let wp of this.wpmemWatchpoints) {
			if (enable)
				await this.setWatchpoint(wp);
			else
				await this.removeWatchpoint(wp);
		}
		this.wpmemEnabled=enable;
	}


	/**
	 * Sets one watchpoint in the remote.
	 * Watchpoints result in a break in the program run if one of the addresses is written or read to.
	 * Promises is execute when last watchpoint has been set.
	 * @param wp The watchpoint to set. Will set 'bpId' in the 'watchPoint'.
	 */
	public async setWatchpoint(wp: GenericWatchpoint): Promise<void> {
		Utility.assert(false);	// override this
	}


	/**
	 * Removes one watchpoint from the remote.
	 * Promises is execute when last watchpoint has been set.
	 * @param wp The watchpoint to renove. Will set 'bpId' in the 'watchPoint' to undefined.
	 */
	public async removeWatchpoint(wp: GenericWatchpoint): Promise<void> {
		Utility.assert(false);	// override this
	}


	/**
	 * Returns the WPMEM watchpoints.
	 */
	public getAllWpmemWatchpoints(): Array<GenericWatchpoint> {
		return this.wpmemWatchpoints;
	}


	/**
	 * Sets the ASSERTs array.
	 * @param assertBreakpoints A list of addresses to put a guard on.
	 */
	public setASSERTArray(assertBreakpoints: Array<GenericBreakpoint>) {
		this.assertBreakpoints=[...assertBreakpoints];
	}


	/**
	 * Enables/disables all assert breakpoints set from the sources.
	 * Promise is called when ready.
	 * @param enable true=enable, false=disable.
	 */
	public async enableAssertBreakpoints(enable: boolean): Promise<void>{
		Utility.assert(false);	// override this
	}

	/**
	 * Returns the ASSERT breakpoints.
	 */
	public getAllAssertBreakpoints(): Array<GenericBreakpoint> {
		return this.assertBreakpoints;
	}


	/**
	 * Sets the LOGPOINTs array.
	 * @param logpoints A list of addresses with messages to put a logpoint on.
	 */
	public setLOGPOINTArray(logpoints: Map<string, Array<GenericBreakpoint>>) {
		this.logpoints=logpoints;
		this.logpointsEnabled=new Map<string, boolean>();
		// All groups:
		for (const [group] of this.logpoints) {
			this.logpointsEnabled.set(group, false);
		}
	}



	/**
	 * Set all log points.
	 * Called at startup and once by enableLogPoints (to turn a group on or off).
	 * Promise is called after the last logpoint is set.
	 * @param logpoints A list of addresses to put a log breakpoint on.
	 * @param enable Enable or disable the logpoints.
	 * @returns A promise that is called after the last watchpoint is set.
	 */
	public async enableLogpoints(logpoints: Array<GenericBreakpoint>, enable: boolean): Promise<void> {
		Utility.assert(false);	// override this
	}



	/**
	 * Enables/disables all logpoints for a given group.
	 * Throws an exception if the group is unknown.
	 * Promise is called all logpoints are set.
	 * Override and assert if logpoints are not supported.
	 * @param group The group to enable/disable. If undefined: all groups. E.g. "UNITTEST".
	 * @param enable true=enable, false=disable.
	 */
	public async enableLogpointGroup(group: string, enable: boolean): Promise<void> {
		let lPoints;

		// Check if one group or all
		if (group) {
			// 1 group:
			const array=this.logpoints.get(group);
			if (!array)
				throw Error("Group '"+group+"' unknown.");
			lPoints=new Map<string, GenericBreakpoint[]>([[group, array]]);
		}
		else {
			// All groups:
			lPoints=this.logpoints;
		}

		// Loop over all selected groups
		for (const [grp, arr] of lPoints) {
			await this.enableLogpoints(arr, enable);
			// Set group state
			this.logpointsEnabled.set(grp, enable);
		}
	}


	/**
	 * @returns Returns a list of all enabled lopgoints from all groups.
	 */
	protected getEnabledLogpoints(): Array<GenericBreakpoint> {
		const result=new Array<GenericBreakpoint>();
		// Loop over all selected groups
		for (const [grp, arr] of this.logpoints) {
			// Set group state
			const enabled=this.logpointsEnabled.get(grp);
			// Add
			if (enabled)
				result.push(...arr);
		}
		return result;
	}


	/**
	 * Sets breakpoint in the Remote.
	 * Sets the breakpoint ID (bpId) in bp.
	 * This method is called also each time a breakpoint is manually set via the
	 * vscode UI.
	 * If set from UI the breakpoint may contain a condition and also a log.
	 * After creation the breakpoint is added to the 'breakpoints' array.
	 * @param bp The breakpoint.
	 * @returns The used breakpoint ID. 0 if no breakpoint is available anymore.
	 */
	public async setBreakpoint(bp: RemoteBreakpoint): Promise<number> {
		Utility.assert(false);	// override this
		// return
		return 0;
	}


	/**
	 * Clears one breakpoint.
	 * Breakpoint is removed at the Remote and removed from the 'breakpoints' array.
	 */
	protected async removeBreakpoint(bp: RemoteBreakpoint): Promise<void> {
		Utility.assert(false);	// override this
	}


	/**
	 * Set all breakpoints for a file.
	 * Determines which breakpoints already exist, which are new and which need to be removed.
	 * Calls setBreakpoint and removeBreakpoint which communicate with the emulator.
	 * If system is running, first break, then set the breakpoint(s).
	 * But, because the run-handler is not known here, the 'run' is not continued afterwards.
	 * @param path The file (which contains the breakpoints).
	 * @param givenBps The breakpoints in the file.
	 * @param tmpDisasmFileHandler(bp) If a line cannot be determined then this handler
	 * is called to check if the breakpoint was set in the temporary disassembler file. Returns
	 * an EmulatorBreakpoint.
	 * @returns A Promise with all breakpoints.
	 */
	public async setBreakpoints(path: string, givenBps: Array<RemoteBreakpoint>): Promise<Array<RemoteBreakpoint>> {

		try {
			// get all old breakpoints for the path
			const oldBps=this.breakpoints.filter(bp => bp.filePath==path);

			// Create new breakpoints
			const currentBps=new Array<RemoteBreakpoint>();
			givenBps.forEach(bp => {
				let ebp;
				// Get PC value of that line
				let addr=this.getAddrForFileAndLine(path, bp.lineNr);
				// Check if valid line
				if (addr>=0) {
					// Now search last line with that pc
					const file=this.getFileAndLineForAddress(addr);
					// Check if right file
					if (path.valueOf()==file.fileName.valueOf()) {
						// create breakpoint object
						ebp={bpId: 0, filePath: file.fileName, lineNr: file.lineNr, address: addr, condition: bp.condition, log: bp.log};
					}
				}

				// add to array
				if (!ebp) {
					// Breakpoint position invalid
					ebp={bpId: 0, filePath: path, lineNr: bp.lineNr, address: -1, condition: '', log: undefined};
				}
				currentBps.push(ebp);
			});

			// Now check which breakpoints are new or removed (this includes 'changed').
			const newBps=currentBps.filter(bp => bp.address>=0&&oldBps.filter(obp => (obp.condition==bp.condition)&&(obp.log==bp.log)&&(obp.address==bp.address)).length==0);
			const removedBps=oldBps.filter(bp => bp.address>=0&&currentBps.filter(obp => (obp.condition==bp.condition)&&(obp.log==bp.log)&&(obp.address==bp.address)).length==0);

			// remove old breakpoints
			removedBps.forEach(async bp => {
				// from zesarux
				await this.removeBreakpoint(bp);
			});

			// Add new breakpoints and find free breakpoint ids
			newBps.forEach(async bp => {
				// set breakpoint
				await this.setBreakpoint(bp);
			});

			// get all breakpoints for the path
			//const resultingBps = this.breakpoints.filter(bp => bp.filePath == path);

			// call handler
			return currentBps;
		}
		catch (e) {
			throw e;
		}
	}


	/**
	 * Returns the remote breakpoints (PC breakpoint) array.
	 */
	public getBreakpointsArray(): Array<RemoteBreakpoint> {
		return this.breakpoints;
	}


	/**
	 * Returns file name and line number associated with a certain memory address.
	 * Takes also the disassembled file into account.
	 * Used e.g.for the call stack.
	 * @param address The memory address to search for.
	 * @returns The associated filename and line number(and for sjasmplus the modulePrefix and the lastLabel).
	 */
	public getFileAndLineForAddress(address: number): SourceFileEntry {
		// Now search last line with that pc
		let file=Labels.getFileAndLineForAddress(address);
		if (!file.fileName) {
			// Search also the disassembled file
			const lineNr=Disassembly.getLineForAddress(address);
			if (lineNr!=undefined) {
				file.fileName=DisassemblyClass.getAbsFilePath();
				file.lineNr=lineNr;
			}
		}
		return file;
	}


	/**
	 * Returns the memory address associated with a certain file and line number.
	 * Takes also the disassembled file into account.
	 * @param fileName The path to the file. Can be an absolute path.
	 * @param lineNr The line number inside the file.
	 * @returns The associated address. -1 if file or line does not exist.
	 */
	public getAddrForFileAndLine(fileName: string, lineNr: number): number {
		let addr=Labels.getAddrForFileAndLine(fileName, lineNr);
		if (addr<0) {
			// Check disassembly
			const absFilePath=DisassemblyClass.getAbsFilePath();
			if (fileName==absFilePath) {
				// Get address from line number
				addr=Disassembly.getAddressForLine(lineNr);
			}
		}
		return addr;
	}


	/**
	/**
	 * Sends a command to the emulator.
	 * Override if supported.
	 * @param cmd E.g. 'get-registers'.
	 * @returns A Promise in remote (emulator) dependend format.
	 */
	public async dbgExec(cmd: string): Promise<string> {
		return "Error: not supported.";
	}


	/**
	 * Reads a memory dump and converts it to a number array.
	 * @param address The memory start address.
	 * @param size The memory size.
	 * @param handler(data, addr) The handler that receives the data. 'addr' gets the value of 'address'.
	 */
	public async readMemoryDump(address: number, size: number): Promise<Uint8Array> {
		Utility.assert(false);	// override this
		return new Uint8Array();
	}


	/**
	 * Writes a memory dump.
	 * @param address The memory start address.
	 * @param dataArray The data to write.
	 */
	public async writeMemoryDump(address: number, dataArray: Uint8Array): Promise<void> {
		Utility.assert(false);	// override this
	}


	/**
	 * Gets one memory value from the remote.
	 * The write is followed by a read and the read value is returned
	 * by the Promise.
	 * @param address The address to change.
	 * @returns A Promise with the value.
	 */
	public async readMemory(address: number): Promise<number> {
		// Read
		const realValue=await this.readMemoryDump(address, 1);
		return realValue[0];
	}


	/**
	 * Writes one memory value to the remote.
	 * The write is followed by a read and the read value is returned
	 * by the Promise.
	 * @param address The address to change.
	 * @param value The new (byte) value.
	 * @returns A Promise with the real value.
	 */
	public async writeMemory(address: number, value: number): Promise<number> {
		// Write
		const data=new Uint8Array([value]);
		await this.writeMemoryDump(address, data);
		// Read
		const realValue=await this.readMemory(address);
		return realValue;
	}


	/**
	 * Reads the memory pages, i.e. the slot/banks relationship from zesarux
	 * and converts it to an arry of MemoryBanks.
	 * @returns A Promise with an array with the available memory pages.
	 */
	public async getMemoryBanks(): Promise<MemoryBank[]> {
		return [];
	}


	/**
	 * Change the program counter and emit 'stoppedEvent'.
	 * @param address The new address for the program counter.
	 */
	public async setProgramCounterWithEmit(address: number): Promise<void> {
		StepHistory.clear();
		Z80Registers.clearCache();
		this.clearCallStack();
		await this.setRegisterValue("PC", address);
		this.emit('stoppedEvent', 'PC changed');
	}

	/**
	 * Change the SP and emit 'stoppedEvent'.
	 * @param address The new address for the stack pointer.
	 */
	public async setStackPointerWithEmit(address: number): Promise<void> {
		StepHistory.clear();
		Z80Registers.clearCache();
		this.clearCallStack();
		await this.setRegisterValue("SP", address);
		this.emit('stoppedEvent', 'SP changed');
	}


	/**
	 * Sets the value of a register and emits a 'stoppedEvent'
	 * This is used by the ShallowVariables when a register is changed.
	 * So that all register values are updated (e.g. in case you change
	 * register "C" also "BC" should be updated.
	 * @param register The register to set, e.g. "BC" or "A'". Note: the register name has to exist. I.e. it should be tested before.
	 * @param value The new register value.
	 */
	public async setRegisterValueWithEmit(register: string, value: number) {
		this.clearCallStack();
		await this.setRegisterValue(register, value);
		this.emit('stoppedEvent', register+' changed');
	}


	/**
	 * Resets the T-States counter. Used before stepping to measure the
	 * time.
	 */
	public async resetTstates(): Promise<void> {
	}


	/**
	 * Returns the number of T-States (since last reset).
	 * @returns The number of T-States or 0 if not supported.
	 */
	public async getTstates(): Promise<number> {
		return 0;
	}


	/**
	 * Returns the current CPU frequency
	 * @returns The CPU frequency in Hz (e.g. 3500000 for 3.5MHz) or 0 if not supported.
	 */
	public async getCpuFrequency(): Promise<number> {
		return 0;
	}


	/**
	 * This method is called by the DebugSessionClass before a step (stepOver, stepInto, stepOut,
	 * continue, stepBack, etc.) is called.
	 * It can be overridden e.g. to clear/initialize some stuff
	 * e.g. coverage.
	 */
	public startProcessing() {
	}


	/**
	 * This method is called by the DebugSessionClass after a step (stepOver, stepInto, stepOut,
	 * continue, stepBack, etc.) is called.
	 * It can be overridden e.g. to do something at the end of a step.
	 * E.g. emit coverage.
	 */
	public stopProcessing() {
	}


	// ZX Next related ---------------------------------

	/**
	 * Retrieves the TBBlue register value from the emulator.
	 * @param registerNr The number of the register.
	 * @returns A promise with the value of the register.
	 */
	public async getTbblueRegister(registerNr: number): Promise<number> {
		return 0;
	}


	/**
	 * Retrieves the sprites palette from the emulator.
	 * @param paletteNr 0 or 1.
	 * @returns A Promise that returns a 256 byte Array<number> with the palette values.
	 */
	public async getTbblueSpritesPalette(paletteNr: number): Promise<Array<number>> {
		return [];
	}


	/**
	 * Retrieves the sprites clipping window from the emulator.
	 * @returns A Promise that returns the clipping dimensions and teh control byte(xl, xr, yt, yb, control).
	 */
	public async getTbblueSpritesClippingWindow(): Promise<{xl: number, xr: number, yt: number, yb: number, control: number}> {
		return {xl: 0, xr: 0, yt: 0, yb: 0, control: 0};
	}


	/**
	 * Retrieves the sprites from the emulator.
	 * @param slot The start slot.
	 * @param count The number of slots to retrieve.
	 * @returns A Promise with an array of sprite data.
	 */
	public async getTbblueSprites(slot: number, count: number): Promise<Array<Uint8Array>> {
		return [];
	}

	/**
	 * Retrieves the sprite patterns from the emulator.
	 * @param index The start index.
	 * @param count The number of patterns to retrieve.
	 * @preturns A Promise with an array of sprite pattern data.
	 */
	public async getTbblueSpritePatterns(index: number, count: number): Promise<Array<Array<number>>> {
		return [];
	}


	/**
	 * This is a hack:
	 * After starting the vscode sends the source file breakpoints.
	 * But there is no signal to tell when all are sent.
	 * So this function waits as long as there is still traffic to the emulator.
	 * @param timeout Timeout in ms. For this time traffic has to be quiet.
	 * @returns A Promise called after being quiet for the given timeout.
	 */
	public async executeAfterBeingQuietFor(timeout: number): Promise<void> {
		// This is a hack for ZEsarUX. Not required for the others.
	}


	/**
	 * Called from "-state save" command.
	 * Stores all RAM, registers etc.
	 * Override.
	 * @param filePath The file path to store to.
	 * @returns State data.
	 */
	public async stateSave(filePath: string): Promise<void> {
	}


	/**
	 * Called from "-state restore" command.
	 * Restores all RAM + the registers from a former "-state save".
	 * Override.
	 * @param filePath The file path to retore from.
	 */
	public async stateRestore(filePath: string): Promise<void> {
	}


	/**
	 * Calculates the step-over/into breakpoint(s) for an instruction.
	 * I.e. it normally calculates the address after the current instruction (pc).
	 * DeZog will set a breakpoint there and execute a 'continue' to simulate
	 * a 'step'.
	 * But for branching or conditional branching instructions this is different.
	 * DeZog will then use up to 2 breakpoints to catch up after the instruction is executed.
	 * The method is async, i.e. it fetches the required registers and memory on it's own.
	 * @param stepOver true if breakpoint address should be calculate for a step-over.
	 * In this case the branching is ignored for CALL and RST.
	 * @returns A Promise with the opcode and 2 breakpoint
	 * addresses.
	 * The first always points directly after the address.
	 * The 2nd of these bp addresses can be undefined.
	 */
	protected async calcStepBp(stepOver: boolean): Promise<[Opcode, number, number?]> {
		// Make sute the registers are there
		await this.getRegisters();
		const pc=this.getPC();
		// Get opcodes
		const opcodes=await this.readMemoryDump(pc, 4);

		// Get opcode length and calculate "normal" breakpoint address
		const buffer=new BaseMemory(pc, opcodes);
		const opcode=Opcode.getOpcodeAt(buffer, pc);
		let bpAddr1=pc+opcode.length;
		let bpAddr2;
		const ocFlags=opcode.flags;

		// Special handling for RST 08 (esxdos) as stepInto may not work
		// if the emulator simulates this.
		if (opcode.code==0xCF) {
			// Note: The opcode length for RST 08 is already adjusted by the disassembler.
			if (stepOver) {
				// For stepOver nothing is required normally.
				// However, as we have a spare breakpoint (bpAddr2),
				// we can set it to the next PC. So that even if
				// esxdosRst was not set a stepOver would stop.
				bpAddr1=pc+1;
				bpAddr2=bpAddr1+1;
			}
			else {
				// If stepInto we need a breakpoint at the jump address 8 (RST 08) but also the bpAddr1 if call is simulated.
				bpAddr2=0x0008;
			}
		}
		// Check for RET
		else if (ocFlags&OpcodeFlag.RET) {
			const sp=this.getRegisterValue("SP");
			// Get return address
			const retArr=await this.readMemoryDump(sp, 2);
			const retAddr=retArr[0]+(retArr[1]<<8);
			// If unconditional only one breakpoint is required
			if (ocFlags&OpcodeFlag.CONDITIONAL)
				bpAddr2=retAddr;
			else
				bpAddr1=retAddr;
		}
		// Check for stepOver and CALL/RST
		else if (stepOver&&(ocFlags&OpcodeFlag.CALL)) {
			// If call and step over we don't need to check the additional
			// branch address.
		}
		// Check for branches (JP, JR, CALL, RST, DJNZ)
		else if (ocFlags&OpcodeFlag.BRANCH_ADDRESS) {
			if (ocFlags&OpcodeFlag.CONDITIONAL) {
				// No step over or no CALL/RST
				bpAddr2=opcode.value;
			}
			else {
				// All others:
				bpAddr1=opcode.value;
			}
		}
		else if (ocFlags&OpcodeFlag.STOP) {
			// In this category there are also the special branches
			// like:
			// JP(HL), JP(IX), JP(IY)
			if (opcodes[0]==0xE9) {
				// JP (HL)
				bpAddr1=this.getRegisterValue("HL");;
			}
			else if (opcodes[0]==0xDD&&opcodes[1]==0xE9) {
				// JP (IX)
				bpAddr1=this.getRegisterValue("IX");;
			}
			else if (opcodes[0]==0xFD&&opcodes[1]==0xE9) {
				// JP (IY)
				bpAddr1=this.getRegisterValue("IY");
			}
		}
		else {
			// Other special instructions
			if (opcodes[0]==0xED) {
				if (opcodes[1]==0xB0||opcodes[1]==0xB8
					||opcodes[1]==0xB1||opcodes[1]==0xB9) {
					// LDIR/LDDR/CPIR/CPDR
					if (!stepOver)
						bpAddr2=pc;
				}
			}
			else if (opcodes[0]==0x76) {
				// HALT
				if (!stepOver)
					bpAddr2=pc;
			}
		}

		// Return either 1 or 2 breakpoints
		return [opcode, bpAddr1, bpAddr2];
	}
}

