import * as net from 'net';
import * as os from 'os';
import * as fs from 'fs';
import * as util from 'util';
import * as path from 'path';
import {Labels} from '../../labels';
import {parseString} from 'xml2js';
import {Settings} from '../../settings';
import {Z80RegistersClass,Z80Registers} from '../z80registers';
import {DecodeOpenMSXRegisters} from './decodeopenmsxdata';
import {Utility} from '../../misc/utility';
import {GenericWatchpoint, GenericBreakpoint} from '../../genericwatchpoint';
import {RemoteBase, RemoteBreakpoint, MemoryBank } from '../remotebase';

export class OpenMSXRemote extends RemoteBase {
	openmsx:net.Socket;
	connected:boolean;
	breakpointmap:string[];
	asserts:string[];

	/// Constructor.
	constructor() {
		super();

		this.connected = false;
		this.breakpointmap = new Array<string>();
		this.asserts = new Array<string>();

		// Set decoder
		Z80Registers.decoder=new DecodeOpenMSXRegisters();
	}

	async connectOpenMSX (): Promise <net.Socket> {
        return new Promise <net.Socket>( async (resolve,reject) => {
            try {
                // Create the socket for communication (not connected yet)
                var folder:string = os.tmpdir()+"/openmsx-"+os.userInfo().username;
                const readDir = util.promisify (fs.readdir);
                const filenames = await readDir (folder);
                filenames.forEach( async (filename) => {
                    var socketpath:string = path.join (folder,filename);
                    const client = net.createConnection (socketpath)
                        .on('connect', () => {
                            console.log('Connected to OpenMSX');
                            resolve (client);
                        })
                        .on('error', (err:Error) => {
                            fs.unlinkSync (socketpath);
                            //reject (null);
                        })
                    });
            } catch {
                reject (new Error ("Error connecting to OpenMSX"));
            }
        });
    }

    async receive_response () : Promise <string> {
        return new Promise <string> ( async (resolve) => {
            this.once ('awake', (str:string) => {
                resolve (str);
            });
        });
    }
    async perform_command (cmd: string) : Promise <string> {
        return new Promise <string> ( async (resolve,reject) => {
			console.log (cmd);
			this.on ('reply', async (r:any) => {
				console.log (util.inspect(r, { depth: null }));
				if (r.$!=undefined && r.$.result=="ok") {
					this.removeAllListeners ("reply");
					if (r._!=undefined)
						resolve (r._); // return value
					else
						resolve (""); // no return value
				}
			});
			this.openmsx.write ("<command>"+cmd+"</command>");
        });
	}

    async perform_run_command (cmd: string) : Promise <string> {
        return new Promise <string> ( async (resolve,reject) => {
			console.log (cmd);
			this.on ('update', async (u:any) => {
				console.log (util.inspect(u, { depth: null }));
				if (u._!=undefined && u._ == "suspended") {
					this.removeAllListeners ("update");
					resolve (u._);
				}
			});
			this.openmsx.write ("<command>"+cmd+"</command>");
        });
	}

    async parse(str:string) : Promise <any> {
        return new Promise <any> ((resolve, reject) => {
          parseString(str, (error: any, result: any) => {
            if (error) reject(error);
            else resolve(result);
          });
        });
	}

	/// Initializes the machine.
	public async doInitialization(): Promise<void> {
		try {
			this.openmsx = await this.connectOpenMSX ()
			this.connected = true;
        } catch (error) {
			console.log (error.message);
			this.emit('error', new Error ("Error connecting to OpenMSX"));
            return;
        }

        this.openmsx.on('timeout', () => {
			this.emit('error', new Error ("Timeout connecting to OpenMSX"));
        })
        this.openmsx.on('error', err => {
			this.emit('error', err);
        })
        this.openmsx.on('close', () => {
			this.emit('log', "Closed the connection to OpenMSX");
        })
        this.openmsx.on ('data', data => {
			this.handleOpenMSXResponse (data);
        });

		await this.receive_response ();

		// do some inits
		if(Settings.launch.resetOnLaunch)
			await this.perform_command ("reset");
		//for (let cmd of Settings.launch.commandsAfterLaunch) {
		//	let msg = await this.perform_command (cmd);
		//	this.emit("log", msg);
		//}

		await this.perform_command ("openmsx_update enable status");
		await this.perform_command ("debug break");

		await this.perform_command (
			"proc debug_bin2hex { input } {\n"+
			"  set result \"\"\n"+
			"  foreach i [split $input {}] {\n"+
			"    append result [format %02X [scan $i %c]] \"\"\n"+
			"  }\n"+
			"  return $result\n"+
			"}\n");
		await this.perform_command(
			"proc debug_memmapper { } {\n"+
			"  set result \"\"\n"+
			"  for { set page 0 } { $page &lt; 4 } { incr page } {\n"+
			"    set tmp [get_selected_slot $page]\n"+
			"    append result [lindex $tmp 0] [lindex $tmp 1] \"\\n\"\n"+
			"    if { [lsearch [debug list] \"MapperIO\"] != -1} {\n"+
			"      append result [debug read \"MapperIO\" $page] \"\\n\"\n"+
			"    } else {\n"+
			"      append result \"0\\n\"\n"+
			"    }\n"+
			"  }\n"+
			"  for { set ps 0 } { $ps &lt; 4 } { incr ps } {\n"+
			"    if [machine_info issubslotted $ps] {\n"+
			"      append result \"1\\n\"\n"+
			"      for { set ss 0 } { $ss &lt; 4 } { incr ss } {\n"+
			"        append result [get_mapper_size $ps $ss] \"\\n\"\n"+
			"      }\n"+
			"    } else {\n"+
			"      append result \"0\\n\"\n"+
			"      append result [get_mapper_size $ps 0] \"\\n\"\n"+
			"    }\n"+
			"  }\n"+
			"  for { set page 0 } { $page &lt; 4 } { incr page } {\n"+
			"    set tmp [get_selected_slot $page]\n"+
			"    set ss [lindex $tmp 1]\n"+
			"    if { $ss == \"X\" } { set ss 0 }\n"+
			"    set device_list [machine_info slot [lindex $tmp 0] $ss $page]\n"+
			"    set name \"[lindex $device_list 0] romblocks\"\n"+
			"    if { [lsearch [debug list] $name] != -1} {\n"+
			"      append result \"[debug read $name [expr {$page * 0x4000}] ]\\n\"\n"+
			"      append result \"[debug read $name [expr {$page * 0x4000 + 0x2000}] ]\\n\"\n"+
			"    } else {\n"+
			"      append result \"X\\nX\\n\"\n"+
			"    }\n"+
			"  }\n"+
			"  return $result\n"+
			"}\n");

		// Send 'initialize' to Machine.
		this.emit('initialized');
	}

	private async handleOpenMSXResponse (data:Buffer) {
		let str:string = data.toString();
		if (str.indexOf ("<openmsx-output>")==0) {
			this.emit ('awake',"");
		} else {
			let v:any = await this.parse (`<openmsx>${str}</openmsx>`);
			if (v.openmsx.reply!=undefined) {
				for (let r of v.openmsx.reply) {
					this.emit ('reply',r);
				}
			}
			if (v.openmsx.update!=undefined) {
				for (let u of v.openmsx.update) {
					this.emit ('update',u);
				}
			}
		}
	}

	public async disconnect(): Promise<void> {
		if (this.connected) {
			// remove all breakpoints
			let str:string = await this.perform_command ("debug list_bp");
			let bps:string[] = str.split ("\n");
			for (let bp of bps) {
				if (bp.trim().length>0)
					await this.perform_command ("debug remove_bp "+bp.split (" ")[0]);
			}
			await this.perform_command ("debug cont");

			this.openmsx.destroy ();
			this.connected = false;
		}
		return;
	}

	/**
	* Make sure the cache is filled.
	* If cache is empty retrieves the registers from
	* the emulator.
	* @param handler(registersString) Passes 'registersString' to the handler.
	*/
	public async getRegisters(): Promise<void> {
		if (!Z80Registers.getCache()) {
			// Get new data
			return this.getRegistersFromEmulator();
		}
	}

	/**
	 * Retrieve the registers from OpenMSX directly.
	 * From outside better use 'getRegisters' (the cached version).
	 * @param handler(registersString) Passes 'registersString' to the handler.
	 */
	protected async getRegistersFromEmulator(): Promise<void>  {
		return new Promise<void>(async resolve => {
			// Get new (real emulator) data
			let cpuregs:string = await this.perform_command ("cpuregs");
			Z80Registers.setCache (cpuregs);
			resolve();
		});
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
	 * Reads the memory pages, i.e. the slot/banks relationship from zesarux
	 * and converts it to an arry of MemoryBanks.
	 * @returns A Promise with an array with the available memory pages.
	 */
	public async getMemoryBanks(): Promise<MemoryBank[]> {
		return new Promise<MemoryBank[]>(async resolve => {
			// pages
			let mbs = new Array<MemoryBank>();
			let output:string = await this.perform_command ("debug_memmapper");
			let lines = output.split ("\n");
			let mappersegment:number[]=[];
			for (let i=0;i<4;i++) {
				let mb:MemoryBank = {
					start: i*0x4000,
					end:((i+1)*0x4000)-1,
					name:`slot ${lines[i*2].charAt(0)}:${lines[i*2].charAt(1)}`
				};
				mappersegment[i]=Number.parseInt(lines[i*2+1]);
				mbs.push (mb);
			}
			// mappers
			let l=8;
			var mappersizes:number[][]=[[0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]];
			for (let p=0;p<4;p++) {
				if (lines[l++].charAt(0)=='1') {
					// subslotted
					for (let s=0;s<4;s++) {
						mappersizes[p][s] = Number.parseInt(lines[l++]);
					}
				} else {
					mappersizes[p][0] = Number.parseInt(lines[l++]);
				}
			}
			// romblocks
			let romblocks:number[]=[];
			for (let i = 0; i < 8; ++i, ++l) {
				if (lines[l][0] == 'X') {
					romblocks[i] = -1;
					if (mbs[Math.floor(i/2)].name.indexOf (",")<0)
						mbs[Math.floor(i/2)].name += `, RAM segment: ${mappersegment[Math.floor(i/2)]}`;
					++i;++l;
					//else
					//	mbs[Math.floor(i/2)].name += `/${mappersegment[Math.floor(i/2)]}`;
				}
				else {
					romblocks[i] = Number.parseInt (lines[l]);
					if (mbs[Math.floor(i/2)].name.indexOf (",")<0)
						mbs[Math.floor(i/2)].name += `, ROM bank   : ${romblocks[i]}`;
					else
						mbs[Math.floor(i/2)].name += `/${romblocks[i]}`;
				}
			}
			resolve (mbs);
		});
	}

	/**
	 * 'continue' debugger program execution.
	 * @returns A Promise with a string.
	 * Is called when it's stopped e.g. when a breakpoint is hit.
	 * reason contains the stop reason as string.
	 */
	public async continue(): Promise<string> {
		return new Promise<string>(async resolve => {
			await this.perform_run_command ("debug cont");
			// (could take some time, e.g. until a breakpoint is hit)
			// Clear register cache
			Z80Registers.clearCache();
			this.clearCallStack();
			// Handle code coverage
			this.handleCodeCoverage();
			// Read the spot history
			//await CpuHistory.getHistorySpotFromRemote();
			let pc:number = await (this.getCurrentPC ());
			resolve(`Breakpoint hit @0x${pc.toString (16)}`);
		});
	}

	/**
	 * 'pause' the debugger.
	 */
	public async pause(): Promise<void> {
		return new Promise<void>(async resolve => {
			await this.perform_command ("debug break");
			resolve ();
		});
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
		return new Promise<{instruction: string, breakReasonString?: string}>(async resolve => {
			let oldpc:number = this.getPC ();
			let disasm:string = await this.perform_command (`debug disasm 0x${oldpc.toString(16)}`);
			disasm = disasm.toUpperCase ();
			if (disasm.indexOf ("CALL")>=0 ||
			    disasm.indexOf ("RST")>=0 ||
				disasm.indexOf ("LDIR")>=0 ||
				disasm.indexOf ("CPIR")>=0 ||
				disasm.indexOf ("INIR")>=0 ||
				disasm.indexOf ("OTIR")>=0 ||
				disasm.indexOf ("LDDR")>=0 ||
				disasm.indexOf ("CPDR")>=0 ||
				disasm.indexOf ("INDR")>=0 ||
				disasm.indexOf ("OTDR")>=0 ||
				disasm.indexOf ("HALT")>=0) {
				let bytestr = disasm.substr (disasm.indexOf ('}')+1).trim();
				let bytes = bytestr.split (' ');
				let newpc = oldpc+bytes.length;

				let strcond:string="";
				if (this.pcInSlot!=undefined && this.pcInSlot.trim().length>0) {
					strcond = ` {[pc_in_slot ${this.pcInSlot}]}`;
				}

				let bpid = await this.perform_command (`debug set_bp 0x${newpc.toString(16)} ${strcond}`);
				await this.perform_run_command ("debug cont");
				await this.perform_command (`debug remove_bp ${bpid}`);
			} else {
				await this.perform_command ("debug step");
			}
			//await this.perform_command ("step_over");
			// Clear register cache
			Z80Registers.clearCache();
			this.clearCallStack();
			// Handle code coverage
			this.handleCodeCoverage();
			// Read the spot history
			//await CpuHistory.getHistorySpotFromRemote();
			let pc:number = await (this.getCurrentPC ());
			let instruction = `Step over to @0x${pc.toString (16)}`;
			resolve({instruction});
		});
	}

	private async getCurrentPC (): Promise <number> {
		return new Promise<number> (async resolve => {
			let PCh:string = await this.perform_command ("debug read {CPU regs} 20");
			let PCl:string = await this.perform_command ("debug read {CPU regs} 21");
			let pc:number = Number.parseInt (PCh)*256 + Number.parseInt (PCl);
			resolve (pc);
		});
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
		return new Promise<{instruction: string, breakReasonString?: string}>(async resolve => {
			await this.perform_command ("debug step");
			// Clear register cache
			Z80Registers.clearCache();
			this.clearCallStack();
			// Handle code coverage
			this.handleCodeCoverage();
			// Read the spot history
			//await CpuHistory.getHistorySpotFromRemote();
			let pc:number = await (this.getCurrentPC ());
			let instruction = `Step to @0x${pc.toString (16)}`;
			resolve({instruction});
		});
	}

	/**
	 * Reads the coverage addresses and clears them in ZEsarUX.
	 */
	protected handleCodeCoverage() {
		// Check if code coverage is enabled
		if(!Settings.launch.history.codeCoverageEnabled)
			return;


	}

	/**
	 * 'step out' of current subroutine.
	 * @returns A Promise with a string containing the break reason.
	 * 'breakReasonString' a possibly text with the break reason.
	 */
	public async stepOut(): Promise<string> {
		return new Promise<string>(async resolve => {
			await this.perform_command ("step_out");
			// Clear register cache
			Z80Registers.clearCache();
			this.clearCallStack();
			// Handle code coverage
			this.handleCodeCoverage();
			// Read the spot history
			//await CpuHistory.getHistorySpotFromRemote();
			let pc:number = await (this.getCurrentPC ());
			let instruction = `Step out to @0x${pc.toString (16)}`;
			resolve(instruction);
		});
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
	 * Enables/disables all assert breakpoints set from the sources.
	 * Promise is called when ready.
	 * @param enable true=enable, false=disable.
	 */
	public async enableAssertBreakpoints(enable: boolean): Promise<void>{
		for (let abp of this.assertBreakpoints) {
			if (enable) {
				// Create breakpoint
				var strcond:string="";
				strcond=this.convertCondition(abp.condition)||'';
				if (this.pcInSlot!=undefined && this.pcInSlot.trim().length>0) {
					if (strcond.length>0)
						strcond = ` {[pc_in_slot ${this.pcInSlot}] &amp;&amp; ${strcond}}`;
					else
						strcond = ` {[pc_in_slot ${this.pcInSlot}]}`;
				} else {
					if (strcond.length>0)
						strcond = ` {${strcond}}`;
				}
				let cmd:string = "debug set_bp 0x"+abp.address.toString(16)+strcond;
				let result:string = await this.perform_command (cmd);
				this.asserts.push (result);
			}
			else {
				// Remove breakpoints
				for (let a of this.asserts) {
					let cmd:string = "debug remove_bp "+a;
					await this.perform_command (cmd);
				}
			}
		}
		this.assertBreakpointsEnabled = enable;
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

	//BC==0x12FA
	//DE==HL+1
	//(A&7Fh) >= 10
	//D==5 || B==0 && C==1
	//B >= (MAX_COUNT+1)/2
	//b@(mylabel) == 50
	//w@(mylabel) == 0x34BC
	//b@(mylabel+5) == 50
	//b@(mylabel+A) == 50
	//b@(HL) > 10
	protected convertCondition(condition?: string): string|undefined {
		if(!condition || condition.length == 0)
			return '';	// No condition

		// Convert labels
		let regex = /\b[_a-z][\.0-9a-z_]*\b/gi;
		let conds = condition.replace(regex, label => {
			// Check if register
			if(Z80RegistersClass.isRegister(label))
				return `[reg ${label}]`;
			// Convert label to number.
			const addr = Labels.getNumberForLabel(label);
			// If undefined, don't touch it.
			if(addr == undefined)
				return label;
			return addr.toString();;
		});
		// special characters
		conds = conds.split ("&").join("&amp;");
		conds = conds.split ("\"").join("&quot;");
		conds = conds.split ("\'").join("&apos;");
		conds = conds.split ("<").join("&lt;");
		conds = conds.split (">").join("&gt;");

		console.log('Converted condition "' + condition + '" to "' + conds + '"');
		return conds;
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
		return new Promise<number>(async resolve => {
			var strcond:string = "";
			// Check for logpoint (not supported)
			if (bp.log) {
				this.emit('warning', 'OpenMSX does not support logpoints ("'+bp.log+'").');
				// set to unverified
				bp.address=-1;
				return 0;
			}
			if (bp.condition) {
				let tmp = this.convertCondition (bp.condition);
				if (tmp!=undefined)
					strcond = tmp;
			}
			if (this.pcInSlot!=undefined && this.pcInSlot.trim().length>0) {
				if (strcond.length>0)
					strcond = ` {[pc_in_slot ${this.pcInSlot}] &amp;&amp; ${strcond}}`;
				else
					strcond = ` {[pc_in_slot ${this.pcInSlot}]}`;
			} else {
				if (strcond.length>0)
					strcond = ` {${strcond}}`;
			}
			let cmd:string = "debug set_bp 0x"+bp.address.toString(16)+strcond;
			let result:string = await this.perform_command (cmd);
			this.breakpointmap[bp.filePath+"-"+bp.lineNr]=result;
			// Add to list
			this.breakpoints.push(bp);
			resolve(bp.bpId);
		});
	}


	/**
	 * Clears one breakpoint.
	 * Breakpoint is removed at the Remote and removed from the 'breakpoints' array.
	 */
	protected async removeBreakpoint(bp: RemoteBreakpoint): Promise<void> {
		return new Promise<void>(async resolve => {
			// Disable breakpoint
			let bpid = this.breakpointmap[bp.filePath+"-"+bp.lineNr];
			let cmd:string = "debug remove_bp "+bpid;
			await this.perform_command (cmd);

			// Remove from list
			let index=this.breakpoints.indexOf(bp);
			Utility.assert(index!==-1, 'Breakpoint should be removed but does not exist.');
			this.breakpoints.splice(index, 1);
		});
	}
	/**
	/**
	 * Sends a command to the emulator.
	 * Override if supported.
	 * @param cmd E.g. 'get-registers'.
	 * @returns A Promise in remote (emulator) dependend format.
	 */
	public async dbgExec(cmd: string): Promise<string> {
		cmd=cmd.trim();
		if (cmd.length==0) {
			// No command given
			throw new Error('No command given.');
		}

		// Send command to OpenMSX
		return new Promise<string>(async resolve => {
			let result:string = await this.perform_command (cmd);
			resolve (result);
		});
	}

	/**
	 * Reads a memory dump and converts it to a number array.
	 * @param address The memory start address.
	 * @param size The memory size.
	 * @param handler(data, addr) The handler that receives the data. 'addr' gets the value of 'address'.
	 */
	public async readMemoryDump(address: number, size: number): Promise<Uint8Array> {
		return new Promise<Uint8Array>(async resolve => {
			const values=new Uint8Array(size);
			if (address<0)
				address += 0xffff;
			if (address+size > 0xffff)
				size = 0; // should not happen but it does
			let str = await this.perform_command (`debug_bin2hex [ debug read_block memory 0x${address.toString(16)} ${size} ]`);
			for (let i=0;i<size;i++)
				values[i] = Number.parseInt (str.substr (i*2,2),16);
			resolve (values);
		});
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
	 * Called from "-state save" command.
	 * Stores all RAM, registers etc.
	 * Override.
	 * @param filePath The file path to store to.
	 * @returns State data.
	 */
	public async stateSave(filePath: string): Promise<void> {
		await this.perform_command (`savestate ${filePath}`);
	}


	/**
	 * Called from "-state restore" command.
	 * Restores all RAM + the registers from a former "-state save".
	 * Override.
	 * @param filePath The file path to retore from.
	 */
	public async stateRestore(filePath: string): Promise<void> {
		await this.perform_command ("debug break");
		await this.perform_command (`loadstate ${filePath}`);
	}

}