import * as Z80js from 'z80js';
import {ZxMemory} from './zxmemory';
import {ZxPorts} from './zxports';
import {Z80RegistersClass} from '../z80registers';
import {MemBuffer} from '../../misc/membuffer'
import {Settings} from '../../settings';


const signed8=(val) => {
	if (val<128)
		return val;
	else
		return val-256;
}

export class Z80Cpu extends Z80js {

	// Easier access to 'this'
	//protected self: any;

	// Time until next interrupt.
	protected remaingInterruptTstates: number;

	// Time for interrupt in T-States
	protected INTERRUPT_TIME=0.02*3500000.0;  // 20ms * 3.5 MHz

	// For calculation of the CPU load.
	// Summarizes all instruction besides HALT.
	protected cpuLoadTstates: number;
	// Summarizes all instruction includding HALT.
	protected cpuTotalTstates: number;
	// cpuLoadTstates divided by cpuTotalTstates.
	protected cpuLoad: number;
	// The number of interrupts to calculate the average from.
	protected cpuLoadRange: number;

	// Counts the current number of interrupts.
	protected cpuLoadRangeCounter: number;

	/// Constructor.
	constructor(memory: ZxMemory, ports: ZxPorts, debug = false) {
		super(memory, ports, debug);
		//this.self=this;
		this.remaingInterruptTstates=this.INTERRUPT_TIME;
		const self=this as any;
		/*
		IM 0: Executes an instruction that is placed on the data bus by a peripheral.
		IM 1: Jumps to address &0038
		IM 2: Uses an interrupt vector table, indexed by value on data bus.
		*/
		self.im=0;	// Just as after interrupt.
		this.cpuLoadTstates=0;
		this.cpuTotalTstates=0;
		this.cpuLoad=1.0;	// Start with full load
		this.cpuLoadRangeCounter=0;
		this.cpuLoadRange=Settings.launch.zsim.cpuLoadInterruptRange;
	}


	/**
	 * Executes one instruction.
	 * @returns true if a vertical interrupt happened.
	 */
	public execute(): boolean {
		const self=this as any;
		const tstatesPrev=self.tStates;
		self.deferInt=false;

		// For checking on halt
		const opcode=self.memory.getMemory8(self.pc);

		// Execute the instruction
		super.execute();

		// Statistics
		const tstatesDiff=self.tStates-tstatesPrev;
		if (opcode!=0x76) {
			// Count everything besides the HALT instruction
			this.cpuLoadTstates+=tstatesDiff;
		}
		this.cpuTotalTstates+=tstatesDiff;
		// Interrupt
		this.remaingInterruptTstates-=tstatesDiff;
		if (this.remaingInterruptTstates<=0) {
			// Interrupt
			this.remaingInterruptTstates=this.INTERRUPT_TIME;
			//this.remaingInterruptTstates=2;
			this.injectInterrupt();
			// Measure CPU load
			this.cpuLoadRangeCounter++;
			if (this.cpuLoadRangeCounter>=this.cpuLoadRange) {
				if (this.cpuTotalTstates>0) {
					this.cpuLoad=this.cpuLoadTstates/this.cpuTotalTstates;
					this.cpuLoadTstates=0;
					this.cpuTotalTstates=0;
					this.cpuLoadRangeCounter=0;
				}
			}
			// Vert. interrupt
			return true;
		}

		// No vert. interrupt
		return false;
	}


	/**
	 * Simulates an interrupt.
	 */
	public injectInterrupt() {
		const self=this as any;
		// Check if interrupts enabled
		if (!self.iff1)
			return;
		if (self.deferInt)
			return;

		// Interrupts allowed.

		// Get PC
		let pc=self.pc;
		// Check if PC is on a HALT instruction
		const opcode=self.memory.getMemory8(pc);
		if (opcode==0x76)
			pc++;	// Step over HALT
		// put PC on the stack
		self.sp-=2;
		self.memory.setMemory16(self.sp, pc);
		// Get interrupt mode and next PC value accordingly
		let intAddr;
		switch (self.im) {
			case 1:	// IM1
				intAddr=0x38;
				break;
			case 2:	// IM2
				const intLocation=self.i<<8;
				intAddr=self.memory.getMemory16(intLocation);
				break;
			default:
				throw Error("IM "+self.im+" not supported.");
		}
		// Change PC to interrupt.
		self.pc=intAddr;
		// Disable further interrupts
		self.iff1=false;
		self.iff2=false;
	}


	/**
	 * Returns the register data in the Z80Registers format.
	 */
	protected getRegisterData(): Uint16Array {
		const self=this as any;
		const r1=self.r1;
		const r2=self.r2;
		// Convert regs
		const regData=Z80RegistersClass.getRegisterData(
			self.pc, self.sp,
			r1.af, r1.bc, r1.de, r1.hl,
			r1.ix, r1.iy,
			r2.af, r2.bc, r2.de, r2.hl,
			self.i, self.r, self.im);
		return regData;
	}


	/**
	 * Returns the register, opcode and sp contents data,
	 */
	protected getHistoryData(): Uint16Array {
		const self=this as any;
		// Get registers
		const regData=this.getRegisterData();
		// Add opcode and sp contents
		const startHist=regData.length;
		const histData=new Uint16Array(startHist+3);
		// Copy registers
		histData.set(regData);
		// Store opcode (4 bytes)
		const pc=self.pc;
		const opcodes=self.memory.getMemory32(pc);
		histData[startHist]=opcodes&0xFFFF;
		histData[startHist+1]=opcodes>>>16;
		// Store sp contents
		const sp=self.sp;
		const spContents=self.memory.getMemory16(sp);
		histData[startHist+2]=spContents;
		// return
		return histData;
	}


	/**
	 * Returns the size the serialized object would consume.
	 */
	public getSerializedSize(): number {
		// Create a MemBuffer to calculate the size.
		const memBuffer=new MemBuffer();
		// Serialize object to obtain size
		this.serialize(memBuffer);
		// Get size
		const size=memBuffer.getSize();
		return size;
	}


	/**
	 * Serializes the object.
	 */
	public serialize(memBuffer: MemBuffer) {
		// Save all registers etc.
		const self=this as any;
		const r1=self.r1;
		const r2=self.r2;
		// Store
		memBuffer.write16(self.pc);
		memBuffer.write16(self.sp);
		memBuffer.write16(r1.af);
		memBuffer.write16(r1.bc);
		memBuffer.write16(r1.de);
		memBuffer.write16(r1.hl);
		memBuffer.write16(r1.ix);
		memBuffer.write16(r1.iy);
		memBuffer.write16(r2.af);
		memBuffer.write16(r2.bc);
		memBuffer.write16(r2.de);
		memBuffer.write16(r2.hl);
		// Also the 1 byte data is stored in 2 bytes for simplicity:
		memBuffer.write8(self.i);
		memBuffer.write8(self.r);
		memBuffer.write8(self.im);
		memBuffer.write8(self.iff1);
		memBuffer.write8(self.iff2);

		// Additional state
		memBuffer.write32(this.remaingInterruptTstates);
	}


	/**
	 * Deserializes the object.
	 */
	public deserialize(memBuffer: MemBuffer) {
		// Restore all registers etc.
		const self=this as any;
		const r1=self.r1;
		const r2=self.r2;
		// Store
		self.pc=memBuffer.read16();
		self.sp=memBuffer.read16();
		r1.af=memBuffer.read16();
		r1.bc=memBuffer.read16();
		r1.de=memBuffer.read16();
		r1.hl=memBuffer.read16();
		r1.ix=memBuffer.read16();
		r1.iy=memBuffer.read16();
		r2.af=memBuffer.read16();
		r2.bc=memBuffer.read16();
		r2.de=memBuffer.read16();
		r2.hl=memBuffer.read16();
		// Also the 1 byte data is stored in 2 bytes for simplicity:
		self.i=memBuffer.read8();
		self.r=memBuffer.read8();
		self.im=memBuffer.read8();
		self.iff1=memBuffer.read8();
		self.iff2=memBuffer.read8();

		// Additional state
		this.remaingInterruptTstates=memBuffer.read32();

		// Reset statistics
		this.cpuLoadTstates=0;
		this.cpuTotalTstates=0;
		this.cpuLoad=1.0;	// Start with full load
	}



	/**
	 * Workaround for error:  "PC incorrect after FDCB instruction", https://github.com/viert/z80js/issues/2
	 */
	protected doBitIndexed(b, addr) {
		super.doBitIndexed(b, addr);
		// Workaround
		const self=this as any;
		self.pc++;	// Correct the PC
	}


	/**
	 * ld__[ix,iy]_d__[a,b,c,d,e,h,l]
	 * Workaround for error:  "ld (ix+0),l not working", https://github.com/viert/z80js/issues/3
	 */
	protected ld__ix_d__a() {
		const self=this as any;
		self.tStates+=19;
		let offset=signed8(self.read8(self.pc++));
		self.write8(self.r1.ix+offset, self.r1.a);
	}
	protected ld__ix_d__b() {
		const self=this as any;
		self.tStates+=19;
		let offset=signed8(self.read8(self.pc++));
		self.write8(self.r1.ix+offset, self.r1.b);
	}
	protected ld__ix_d__c() {
		const self=this as any;
		self.tStates+=19;
		let offset=signed8(self.read8(self.pc++));
		self.write8(self.r1.ix+offset, self.r1.c);
	}
	protected ld__ix_d__d() {
		const self=this as any;
		self.tStates+=19;
		let offset=signed8(self.read8(self.pc++));
		self.write8(self.r1.ix+offset, self.r1.d);
	}
	protected ld__ix_d__e() {
		const self=this as any;
		self.tStates+=19;
		let offset=signed8(self.read8(self.pc++));
		self.write8(self.r1.ix+offset, self.r1.e);
	}
	protected ld__ix_d__h() {
		const self=this as any;
		self.tStates+=19;
		let offset=signed8(self.read8(self.pc++));
		self.write8(self.r1.ix+offset, self.r1.h);
	}
	protected ld__ix_d__l() {
		const self=this as any;
		self.tStates+=19;
		let offset=signed8(self.read8(self.pc++));
		self.write8(self.r1.ix+offset, self.r1.l);
	}

	protected ld__iy_d__a() {
		const self=this as any;
		self.tStates+=19;
		let offset=signed8(self.read8(self.pc++));
		self.write8(self.r1.iy+offset, self.r1.a);
	}
	protected ld__iy_d__b() {
		const self=this as any;
		self.tStates+=19;
		let offset=signed8(self.read8(self.pc++));
		self.write8(self.r1.iy+offset, self.r1.b);
	}
	protected ld__iy_d__c() {
		const self=this as any;
		self.tStates+=19;
		let offset=signed8(self.read8(self.pc++));
		self.write8(self.r1.iy+offset, self.r1.c);
	}
	protected ld__iy_d__d() {
		const self=this as any;
		self.tStates+=19;
		let offset=signed8(self.read8(self.pc++));
		self.write8(self.r1.iy+offset, self.r1.d);
	}
	protected ld__iy_d__e() {
		const self=this as any;
		self.tStates+=19;
		let offset=signed8(self.read8(self.pc++));
		self.write8(self.r1.iy+offset, self.r1.e);
	}
	protected ld__iy_d__h() {
		const self=this as any;
		self.tStates+=19;
		let offset=signed8(self.read8(self.pc++));
		self.write8(self.r1.iy+offset, self.r1.h);
	}
	protected ld__iy_d__l() {
		const self=this as any;
		self.tStates+=19;
		let offset=signed8(self.read8(self.pc++));
		self.write8(self.r1.iy+offset, self.r1.l);
	}

	/**
	 * LD (IX/IY+d),n
	 * Workaround for error:  "ld (ix+0),l not working", https://github.com/viert/z80js/issues/3
	 */
	protected ld__ix_d__n() {
		const self=this as any;
		self.tStates+=19;
		let offset=signed8(self.read8(self.pc++));	// d
		let value=signed8(self.read8(self.pc++));	// n
		self.write8(self.r1.ix+offset, value);
	}
	protected ld__iy_d__n() {
		const self=this as any;
		self.tStates+=19;
		let offset=signed8(self.read8(self.pc++));	// d
		let value=signed8(self.read8(self.pc++));	// n
		self.write8(self.r1.iy+offset, value);
	}
}
