import { Labels } from '../labels';
import { Settings } from '../settings';
import { Z80RegistersClass } from '../remotes/z80registers';
import { Remote } from '../remotes/remotefactory';
import * as fs from 'fs';
import * as path from 'path';
import {Log} from '../log';




export class Utility {

	/// The rootpath to the project. Used in abs and relative filename functions.
	protected static rootPath: string;

	/// The extension's path.
	protected static extensionPath: string;

	/**
	 * Returns a value shrinked to a boundary.
	 * Used to calculate address boundaries.
	 * E.g. the boundary of 19 to a 16 boundary is 16.
	 * @param value The value to bound.
	 * @param boundary The boundary, usually 16.
	 * @returns The bounded value.
	 */
	public static getBoundary(value: number, boundary: number): number {
		// Boundary check
		if(value < 0)	// Always return 0 for negative values
			return 0;
		const boundValue = value - (value % boundary);
		return boundValue;
	}


	/**
	 * Returns a hex string from a number with leading zeroes.
	 * @param value The number to convert
	 * @param size The number of digits for the resulting string.
	 * @returns E.g. "AF" or "0BC8"
	 */
	public static getHexString(value: number|undefined, size: number): string {
		if(value != undefined) {
			var s = value.toString(16);
			const r = size - s.length;
			if(r < 0)
				return s.substr(-r);	// remove leading digits
			return "0".repeat(r) + s.toUpperCase();
		}
		// Undefined
		return "?".repeat(size);
	}


	/**
	 * Returns a binary string from a number with leading zeroes.
	 * @param value The number to convert
	 * @param size The number of digits for the resulting string.
	 */
	public static getBitsString(value: number, size: number) {
		var s = value.toString(2);
		return "0".repeat(size - s.length) + s;
	}


	/**
	 * Strips the assembler ';' comment from the line.
	 * @param line The line to strip.
	 * @returns The line without any comment.
	 */
	public static stripComment(line: string): string {
		// find comment character
		const k = line.indexOf(';');
		if(k < 0)
			return line;	// no comment
		// Return anything but the comment
		return line.substr(0,k);
	}


	/**
	 * Parses a string and converts it to a number.
	 * The string might be decimal or in an hex format.
	 * If the string begins with '0x' or '$' or ends with 'h' or 'H'
	 * it is assumed to be a hex value.
	 * If the string ends with 'b' or 'B' a bit value is assumed.
	 * Otherwise decimal is used.
	 * If the string starts with _ a flag value is assumed. I.e. following flags
	 * are allowed: SZHPNC
	 * Otherwise decimal is used.
	 * @param valueString The string to convert. Ignores case.
	 * @returns The value of valueString. Can also return NaN in error cases.
	 */
	public static parseValue(valueString: string): number {

		const match = /^\s*((0x|\$)([0-9a-f]+)([^0-9a-f]*))?(([0-9a-f]+)h(.*))?(([01]+)b(.*))?(_([szhnpc]+)([^szhnpc])*)?((-?[0-9]+)([^0-9]*))?('([\S ]+)')?/i.exec(valueString);
		if(!match)
			return NaN;	// Error during parsing

		const ghex = match[3];	// 0x or $
		const ghex_empty = match[4];	// should be empty

		const ghexh = match[6];	// h
		const ghexh_empty = match[7];	// should be empty

		const gbit = match[9];	// b
		const gbit_empty = match[10];	// should be empty

		var gflags = match[12];	// _
		const gflags_empty = match[13];	// should be empty

		const gdec = match[15];	// decimal
		const gdec_empty = match[16];	// should be empty

		var gchar = match[18];	// ASCII character

		// Hex
		if(ghex) {
			if(ghex_empty)
				return NaN;
			return parseInt(ghex, 16);
		}
		if(ghexh) {
			if(ghexh_empty)
				return NaN;
			return parseInt(ghexh, 16);
		}

		// Decimal
		if(gdec) {
			if(gdec_empty)
				return NaN;
			return parseInt(gdec, 10);;
		}
		// Bits
		if(gbit) {
			if(gbit_empty)
				return NaN;
			return parseInt(gbit, 2);
		}

		// Check if status flag value
		if(gflags) {
			if(gflags_empty)
				return NaN;
			gflags = gflags.toLowerCase()
			var flags = 0;
			if(gflags.includes('s')) flags |= 0x80;
			if(gflags.includes('z')) flags |= 0x40;
			if(gflags.includes('h')) flags |= 0x10;
			if(gflags.includes('p')) flags |= 0x04;
			if(gflags.includes('n')) flags |= 0x02;
			if(gflags.includes('c')) flags |= 0x01;
			return flags;
		}

		// ASCII character
		if(gchar) {
			if(gchar.length < 1)
				return NaN;
			return gchar.charCodeAt(0);
		}

		// Unknown
		return NaN;
	}


	/**
	 * Evaluates the given expression.
	 * Also checks if there are elements to convert first, e.g. labels are converted
	 * to numbers first.
	 * Examples:
	 * 2-5*3 => -13, -Dh
	 * LBL_TEST+1 => 32769, 8001h
	 * HL' != 1111h
	 * @param expr The expression to evaluate. May contain math expressions and labels.
	 * Also evaluates numbers in formats like '$4000', '2FACh', 100111b, 'G'.
	 * @param evalRegisters If true then register names will also be evaluated.
	 * @param modulePrefix An optional prefix to use for each label. (sjasmplus)
	 * @param lastLabel An optional last label to use for local labels. (sjasmplus)
	 * @returns The evaluated number. (If a boolean expression is evaluated a 1 is returned for true and a 0 for false)
	 * @throws SyntaxError if 'eval' throws an error or if the label is not found.
	 */
	public static evalExpression(expr: string, evalRegisters = true, modulePrefix?:string, lastLabel?: string): number {
		const exprLabelled = expr.replace(/([\$][0-9a-fA-F]+|[a-fA-F0-9]+h|[0-9]+\S+|0x[a-fA-F0-9]+|[a-zA-Z_\.][a-zA-Z0-9_\.]*'?|'[\S ]+')/g, (match, p1) => {
			let res;
			if(evalRegisters) {
				// Check if it might be a register name.
				if(Z80RegistersClass.isRegister(p1)) {
					// Note: this is called synchronously because the cached register is available.
					// If (it should not but if) it would be called asynchronously the
					// addressString would simply be not decoded.
					try {
						res = Remote.getRegisterValue(p1);
					}
					catch {};
				}
			}
			if(isNaN(res)) {
				// Assume it is a label or number
				let lbl = p1;
				// Local label?
				if(lastLabel && lbl.startsWith('.')) {
					lbl = lastLabel + lbl;
				}
				// module prefix?
				if(modulePrefix) {
					res = Labels.getNumberFromString(modulePrefix+lbl) || NaN;
				}

				if(isNaN(res)) {
					// Check for "normal" label
					res = Labels.getNumberFromString(lbl);
					if(isNaN(res))
						res = p1;	// Return unchanged substring
				}
			}
			return res.toString();
		});

		// Evaluate
		const result = eval(exprLabelled);

		// Check if boolean
		if(typeof(result) == 'boolean')
			return (result) ? 1 : 0;

		// Return normal number
		return result;
	}


	/**
	 * Evaluates/formats a logstring.
	 * The LOGPOINT syntax is:
	 * ; LOGPOINT [group] text ${(var):signed} text ${reg:hex} text ${w@(reg)} text ${b@(reg):unsigned}
	 * with:
	 * [group]: (Note: the [ ] are meant literally here) The log group. Separate log groups might be turned on/off separately. E.g. "[SPRITES]". If omitted  DEFAULT" is used as group.
	 * reg: a register name, e.g. A, BC, HL, IX, H, IXL.
	 * var: a label.
	 * text: A simple text that may include variables. Here are a few examples for variables:
	 * LOGPOINT [SPRITES] Status=${A}, Counter=${(sprite.counter):unsigned}
	 * LOGPOINT Status=${w@(HL)}, ${(DE)}, ${b@(DE)} Note: ${(DE)} is equal to ${b@(DE)} and prints the byte value at DE.
	 *
	 * The function is asynchronous as it might make calls to the Remote.
	 * @param logString Starts after the [group].
	*/
	public static async evalLogString(logString: string): Promise<string> {
		// logString e.g. "${b@(HL):hex}"
		await Remote.getRegisters();	// Make sure that registers are available.

		// Replace does not work asynchrounously, therefore we need to store the results in arrays.
		const offsets: Array<number>=[];
		const promises: Array<Promise<string>> = [];

		const regex=/\${(.*?)(:(.*?))?}/g;
		const reAt=/([bw]@)?\((.*?)\)/i;
		let offsCorrection=0;
		logString = logString.replace(regex, (match, statement /*p1*/, p2, format /*p3*/, offset) => {
			// 'statement' contains the statement, e.g. "b@(HL)".
			// 'format' contains the formatting, e.g. "hex".
			let promise=new Promise<string>(async resolve => {
				let size=1;
				try {
					let value;
					const reMatch=reAt.exec(statement);
					if (reMatch) {
						// Found something like "b@(HL)", "w@(LABEL)" or "(DE)".
						size=(reMatch[1]?.startsWith('w'))? 2:1;
						// Get value of 'inner'
						const addrString=reMatch[2];
						const addr=Utility.evalExpression(addrString);
						// Get memory contents
						const memValues=await Remote.readMemoryDump(addr, size);
						value=memValues[0];
						if (size>1)
							value+=memValues[1]<<8;
					}
					else {
						// It's a simple value, register or label.
						value=Utility.evalExpression(statement, true);
						if (Z80RegistersClass.isRegister(statement)&&statement.length>1)
							size=2;	// Two byte register, e.g. "DE"
					}

					// Now format value
					let formatString=format||'unsigned';
					formatString='${'+formatString+'}';
					const result=await this.numberFormatted('', value, size, formatString, undefined);
					resolve(result);
				}
				catch (e) {
					// Return the error in case of an error.
					resolve(e);
				}
			});
			// Store
			offset-=offsCorrection;
			offsets.push(offset);
			promises.push(promise);
			offsCorrection+=match.length;
			return '';
		});

		// Wait on all promises
		const data=await Promise.all(promises);

		// Create string
		let result='';
		let replacement;
		let i=0;
		while (replacement=data.shift()) {
			const offset=offsets.shift() as number;
			const length=offset-i;
			result+=logString.substr(i, length);
			i=offset;
			result+=replacement;
		}
		// Add last
		result+=logString.substr(i);

		return result;
	}


	/**
	 * Calculates the (minimum) tabsize from the format string.
	 * For all formats the max. string length is assumed and then
	 * the tab size is calculated.
	 * Note 1: this is not meant for ${name} or ${labels} as these can
	 * vary in size.
	 * Note 2: This cannot be achieved by running 'numberFormattedBy' with a
	 * max. value because the max. string may vary for the different formats.
	 * @param format The format string, e.g. "${hex}\t(${unsigned})"
	 * @param size The value size in bytes. (1=byte, 2= word).
	 * @returns An array of numbers with the size of each tab +1 (1 for a space).
	 */
	public static calculateTabSizes(format: string, size: number): any {
		// Test if format string includes tabs
		if(!format.includes('\t'))
			return null;	// no tabs
		// Replace every formatting with maximum size replacement
		var result = format.replace(/\${([^}]*?:)?([^:]*?)(:[\s\S]*?)?}/g, (match, p1, p2, p3) => {
			var usedSize = size;
			// Check modifier p1
			const modifier = (p1 == null) ? '' : p1.substr(0, p1.length-1);
			switch(modifier) {
				case 'b@':
					usedSize = 1;
					break;
				case 'w@':
					usedSize = 2;
					break;
				}
			// Check formatting
			switch(p2) {
				case 'name':
					return "nn";
				case 'hex':
					return "h".repeat(2*usedSize);
				case 'dhex':
					if(usedSize == 2)
						return "hhhhh";
					// Otherwise just like 'hex'.
					// Flow through.
				case 'hex':
					return "h".repeat(2*usedSize);
				case 'bits':
					return "b".repeat(8*usedSize);
				case 'unsigned':
					return (Math.pow(256, usedSize)-1).toString();
				case 'signed':
					return '-' + (Math.pow(256, usedSize)/2).toString();
				case 'char':
					return "c";
				case 'flags':
					return "SZHPNC";
				case 'labels':
				case 'labelsplus':
					return "ll";
			}
			// default
			return "";
		});

		// Now get max. length
		const arr = result.split('\t');
		return arr;
	}


	/**
	 * Returns the ASCII character for a given value.
	 * @param value The value to convert
	 * @returns An ASCII character. Some special values for not printable characters.
	 */
	public static getASCIIChar(value: number): string {
		const res = (value == 0) ? '0\u0332' : ((value >= 32 && value < 127) ? String.fromCharCode(value) : '.');
		return res;
	}

	/**
	 * Same as getASCIIChar but returns &nbsp; instead of a space.
	 * @param value The value to convert
	 * @returns An ASCII/HTML character. Some special values for not printable characters.
	 */
	public static getHTMLChar(value: number): string {
		const res = (value == ' '.charCodeAt(0)) ? '&nbsp;' : Utility.getASCIIChar(value);
		return res;
	}


	/**
	 * Returns a formatted number.
	 * Formatting is done according to size and especially the format string.
	 * @param name The name, e.g. a register name "A" etc. or a label name
	 * @param value The value to convert
	 * @param size The size of the value, e.g. 1 for a byte and 2 for a word
	 * @param format The format string:
	 * ${name} = the name of the register, e.g. HL
	 * ${hex} = value as hex, e.g. A9F5
	 * ${dhex} = value as hex but (for words) with a space in between, useful for double registers, e.g. "A9 F5"
	 * ${unsigned} = value as unsigned, e.g. 1234
	 * $(signed) = value as signed, e.g. -59
	 * $(bits) = value as bits , e.g. 10011011
	 * $(flags) = value interpreted as status flags (only useful for F and F'), e.g. ZNC
	 * ${labels} = value as label (or several labels)"
	 * @param tabSizeArr An array of strings each string contains the max number of characters for each tab. Or null. If null the tab sizes are calculated on the fly.
	 * @param undefText Text to use if value is undefined. Defaults to "undefined".
	 * @returns A Promised with the formatted string.
	 * A Promise is required because it might be that for formatting it is required to
	 * get more data from the socket.
	 */
	public static async numberFormatted(name: string, value: number, size: number, format: string, tabSizeArr: Array<string>|undefined, undefText = "undefined"): Promise<string> {
		// Safety check
		if(value == undefined) {
			return undefText;
		}

		// Variables
		var memWord = 0;
		let regsAsWell=false;

		// Check if registers might be returned as well.
		// Return registers only if 'name' itself is not a register.
		if (!Z80RegistersClass.isRegister(name)) {
			regsAsWell=true;
			await Remote.getRegisters();
		}

		// Check first if we need to retrieve address values
		const matchAddr=/(\${b@:|\${w@:)/.exec(format);
		if (matchAddr) {
			// Retrieve memory values
			const data=await Remote.readMemoryDump(value, 2);
			const b1=data[0]
			const b2=data[1];
			memWord=(b2<<8)+b1;
		}

		// Formatting
		var valString=Utility.numberFormattedSync(value, size, format, regsAsWell, name, memWord, tabSizeArr);

		// Return
		return valString;
	}


	/**
	 * Returns a formatted number.
	 * Formatting is done according to size and especially the format string.
	 * This function works synchronously, if wordAtAddress or register values should be used
	 * they have to be retrieved beforehand or use 'numberFormatted', the asynchrous version.
	 * @param value The value to convert.
	 * @param size The size of the value, e.g. 1 for a byte and 2 for a word.
	 * @param format The format string:
	 * ${name} = the name of the register, e.g. HL
	 * ${hex} = value as hex, e.g. A9F5
	 * ${dhex} = value as hex but (for words) with a space in between, useful for double registers, e.g. "A9 F5"
	 * ${unsigned} = value as unsigned, e.g. 1234
	 * $(signed) = value as signed, e.g. -59
	 * $(bits) = value as bits , e.g. 10011011
	 * $(flags) = value interpreted as status flags (only useful for Fand F#), e.g. ZNC
	 * ${labels} = value as label (or several labels)"
	 * @param regsAsWell If true then also matching register names will be returned.
	 * @param paramName The name, e.g. a register name "A" etc. or a label name. Can be omitted or undefined or ''.
	 * @param paramWordAtAddress If value is an address and formatting should print that the value is given here.
	 * The same value (the low byte) is also used for displaying the byte at address. Can be omitted or 0 if unused.
	 * @param tabSizeArr An array of strings each string contains the max number of characters for each tab. Or null. If null the tab sizes are calculated on the fly.
	 * @returns The formatted string.
	 */
	public static numberFormattedSync(value: number, size: number, format: string, regsAsWell = false, paramName?: string, paramWordAtAddress?: number, tabSizeArr?: Array<string>): string {
		// Check for defaults
		const name = paramName || '';
		const wordAtAddress = paramWordAtAddress || 0;
		// Search for format string '${...}'
		// Note: [\s\S] is the same as . but also includes newlines.
		// First search for '${'
		var valString = format.replace(/\${([\s\S]*?)(?=\${|$)/g, (match, p) => {
			// '${...' found now check for } from the left side.
			// This assures that } can also be used inside a ${...}
			const k = p.lastIndexOf('}');
			if(k < 0) {
				// Not a ${...} -> continue
				return p;
			}
			const p1 = p.substr(0,k);
			const restP = p.substr(k+1);
			// Complete '${...}' found. now check content
			const innerMatch = /^([^\|]*?:)?([^\|]*?)(\|[\s\S]*?)?(\|[\s\S]*?)?$/.exec(p1);
			if(innerMatch == undefined)
				return '${'+p1+'???}' + restP;
			// Modifier
			var usedValue;
			var usedSize;
			var modifier = innerMatch[1];	// e.g. 'b@:' or 'w@:'
			modifier = (modifier == null) ? '' : modifier.substr(0, modifier.length-1);
			switch(modifier) {
				case 'b@':
					usedValue = wordAtAddress & 0xFF;	// use byte at address
					usedSize = 1;
					break;
				case 'w@':
					usedValue = wordAtAddress;	// use word at address
					usedSize = 2;
					break;
				case '':	// no modifier found
				default:	// in case of 'labels'
					usedValue = value;	// normal case
					usedSize = size;
					break;
			}
			// Continue formatting
			const formatting = innerMatch[2];	// e.g. 'hex' or 'name' or the pre-strign for labels
			var innerLabelSeparator = innerMatch[3];	// e.g. ', '
			innerLabelSeparator = (innerLabelSeparator == null) ? '' : innerLabelSeparator.substr(1);
			var endLabelSeparator = innerMatch[4];	// e.g. ', '
			endLabelSeparator = (endLabelSeparator == null) ? '' : endLabelSeparator.substr(1);
			switch(formatting) {
				case 'name':
					return name + restP;
				case 'dhex':
					if(usedSize == 2) {
						return Utility.getHexString(usedValue>>8,2) + ' ' + Utility.getHexString(usedValue&0xFF,2) + restP;
					}
					// Otherwise just like 'hex'.
					// Flow through.
				case 'hex':
					return Utility.getHexString(usedValue,2*usedSize) + restP;
				case 'bits':
					return Utility.getBitsString(usedValue,usedSize*8) + restP;
				case 'unsigned':
					return usedValue.toString() + restP;
				case 'signed':
					const maxValue = Math.pow(256,usedSize);
					const halfMaxValue = maxValue/2;
					return ((usedValue >=  halfMaxValue) ? usedValue-maxValue : usedValue).toString() + restP;
				case 'char':
					const s = Utility.getASCIIChar(usedValue);
					return s + restP
				case 'flags':
					// interprete byte as Z80 flags:
					// Zesarux: (e.g. "SZ5H3PNC")
					// S Z X H X P/V N C
					var res = (usedValue&0x80)? 'S' : '.';	// S=sign
					res += (usedValue&0x40)? 'Z ' : 'NZ';	// Z=zero
					res += (usedValue&0x10)? 'H' : '.';	// H=Half Carry
					res += (usedValue&0x04)? 'P' : '.';	// P/V=Parity/Overflow
					res += (usedValue&0x02)? 'N' : '.';	// N=Add/Subtract
					res += (usedValue&0x01)? 'C ' : 'NC';	// C=carry
					return res + restP;

				case 'labels':
				{
					// calculate labels
					const labels = Labels.getLabelsForNumber(value, regsAsWell);
					// format
					if(labels && labels.length > 0)
						return modifier + labels.join(innerLabelSeparator) + endLabelSeparator + restP;
					// No label
					return '' + restP;
				}

				case 'labelsplus':
				{
					// calculate labels
					const labels = Labels.getLabelsPlusIndexForNumber(value, regsAsWell);
					// format
					if(labels && labels.length > 0)
						return modifier + labels.join(innerLabelSeparator) + endLabelSeparator + restP;
					// No label
					return '' + restP;
				}

				default:
					// unknown formatting
					return '${'+1+'???}' + restP;
			}
		});

		// Format on tabs
		if(!tabSizeArr)
			tabSizeArr = Utility.calculateTabSizes(format, size);
		if(tabSizeArr)
			if(tabSizeArr.length == valString.split('\t').length) {
				var index = 0;
				valString += '\t';	// to replace also the last string
				valString = valString.replace(/(.*?)\t/g, (match, p1, offset) => {
					Utility.assert(tabSizeArr);
					var tabSize = tabSizeArr![index].length;
					//if(index == 0)
					//	--tabSize;	// First line missing the space in front
					++index;
					var result = p1 + " ";
					// right adjusted
					const repeatLen = tabSize-p1.length;
					if(repeatLen > 0)
						result = " ".repeat(repeatLen) + result;
					return result;
				});
		}


		// return
		return valString;
	}


	/**
	 * Returns the formatted register value. Does a request to zesarux to obtain the register value.
	 * @param regIn The name of the register, e.g. "A" or "BC"
	 * @param formatMap The map with the formattings (hover map or variables map)
	 * @returns A Promise with the formatted string.
	 */
	public static async getFormattedRegister(regIn: string, formatMap: any): Promise<string> {
		// Every register has a formatting otherwise it's not a valid register name
		const reg=regIn.toUpperCase();
		const format=formatMap.get(reg);
		Utility.assert(format!=undefined, 'Register '+reg+' does not exist.');

		await Remote.getRegisters();
		// Get value of register
		const value=Remote.getRegisterValue(reg);

		// do the formatting
		let rLen;
		if (reg=="IXH"||reg=="IXL"||reg=="IYH"||reg=="IYL") {
			// Value length = 1 byte
			rLen=1;
		}
		else {
			rLen=reg.length;
			if (reg[rLen-1]=='\'')--rLen;	// Don't count the "'" in the register name
		}

		const formattedRegister=await Utility.numberFormatted(reg, value, rLen, format, undefined);
		return formattedRegister;
	}


	/**
	 * If absFilePath starts with vscode.workspace.rootPath
	 * this part is removed.
	 * @param absFilePath An absolute path
	 * @returns A relative path
	 */
	public static getRelFilePath(absFilePath: string): string {
		//const filePath = path.relative(Utility.rootPath || '', absFilePath);
		let filePath=absFilePath;
		let rootPath=Utility.rootPath;
		if (rootPath) {
			if (!rootPath.endsWith('/'))
				rootPath+='/';
			if (filePath.startsWith(rootPath))
				filePath=filePath.substr(rootPath.length);
		}
		return filePath;
	}


	/**
	 * If relFilePath is a relative path the vscode.workspace.rootPath
	 * path is added.
	 * @param relFilePath A relative path
	 * @returns An absolute path
	 */
	public static getAbsFilePath(relFilePath: string, rootPath?: string): string {
		if(path.isAbsolute(relFilePath))
			return relFilePath;
		// Change from relative to absolute
		const usedRootPath = (rootPath) ? rootPath : Utility.rootPath || '';
		const filePath = path.join(usedRootPath, relFilePath);
		return filePath;
	}


	/**
	 * Looks for a file in the given directories.
	 * If found returns it's absolute file path.
	 * @param srcPath The file to search.
	 * @param srcDirs The (relative) directories to search in.
	 */
	public static getAbsSourceFilePath(srcPath: string, srcDirs: Array<string>) {
		if (path.isAbsolute(srcPath))
			return srcPath;
		// Check all sources directories and try to locate the srcPath file.
		for (let srcDir of srcDirs) {
			const fPath=path.join(srcDir, srcPath);
			const absFPath=Utility.getAbsFilePath(fPath);
			if (fs.existsSync(absFPath))
				return absFPath;
		}
		// Not found, return given path
		return srcPath;
	}


	/**
	 * Returns the relative path srcPath is found in.
	 * I.e. searches for srcPath in all srcDirs and returns the path+the src dir.
	 * @param srcPath E.g. "src/main.asm"
	 * @param srcDirs E.g. [ "src", "includes" ]
	 */
	public static getRelSourceFilePath(srcPath: string, srcDirs: Array<string>) {
		if (path.isAbsolute(srcPath))
			return Utility.getRelFilePath(srcPath);

		// Check all sources directories and try to locate the srcPath file.
		for (let srcDir of srcDirs) {
			const fPath=path.join(srcDir, srcPath);
			const absFPath=Utility.getAbsFilePath(fPath);
			if (fs.existsSync(absFPath))
				return fPath;
		}
		// Not found, return given path
		return srcPath;
	}


	/**
	 * Returns the file path of a file in the tmp dir.
	 * @param fileName E.g. "state0.bin"
	 * @returns The relative file path, e.g. ".tmp/state0.bin".
	 */
	public static getRelTmpFilePath(fileName: string): string {
		const relFilePath = path.join(Settings.launch.tmpDir, fileName);
		return relFilePath;
	}


	/**
	 * Returns the file path of a state filename. Used for
	 * saving/loading the state.
	 * @param stateName A state name that is appended, e.g. "0"
	 * @returns The abs file path, e.g. "/Volumes/.../.tmp/state_0.bin".
	 */
	public static getAbsStateFileName(stateName: string): string {
		const fPath=path.join('states', stateName)
		const relPath=Utility.getRelTmpFilePath(fPath);
		return Utility.getAbsFilePath(relPath);
	}


	/**
	 * Sets the root path or absolute and relative file functions.
	 * @param rootPath What e.g. vscode.workspace.rootPath would return
	 */	public static setRootPath(rootPath: string) {
		Utility.assert(rootPath);
		(Utility.rootPath as any)=rootPath;
	}


	/**
	 * Sets the extension's path.
	 * @param extPath Use what vscode.extensions.getExtension("maziac").extensionPath returns.
	 */
	public static setExtensionPath(extPath: string) {
		Utility.extensionPath=extPath;
	}


	/**
	 * Returns the extension's path.
	 * @return The path.
	 */
	public static getExtensionPath() {
		return Utility.extensionPath;
	}


	/**
	 * Removes all files in tmpDir that start with "TMP_".
	 */
	public static removeAllTmpFiles() {
		const dir = Settings.launch.tmpDir;
		// Check if dir exists
		if(!fs.existsSync(dir))
			return;
		// Loop through all files
		const fileNames = fs.readdirSync(dir);
		for(let fName of fileNames) {
			// Check that filename starts with "TMP_"
			if(fName.startsWith("TMP_")) {
				// Remove file
				const absFName = Utility.getAbsFilePath(fName,dir);
				fs.unlinkSync(absFName);
			}
		}
	}


	/**
	 * Call the 'handler' in an interval until 'handler' returns true.
	 * This can be used to wait on an event to happen, e.g. to poll
	 * a variable.
	 * @param handler(time) The handler. I t normally checks a value
	 * and acts accordingly. E.g. it polls a variable and does
	 * some action when it changes.
	 * When the handler should not be called anymore it need to return true.
	 * The handler gets parameter time in secs. So it#s possible
	 * to check how long this function already tries.
	 * @param interval Interval in secs
	 */
	public static delayedCall(handler: (time: number) => boolean, interval = 0.1) {
		let count = 0;
		const f = () => {
			const time = count*interval;
			const result = handler(time);
			if(result)
				return;
			// Set timeout to wait for next try
			count ++;
			setTimeout(() => {
				f();
			}, interval*1000);
		};

		// Start waiting
		f();
	}


	/**
	 * Helper method to set a WORD from two successing indices in the
	 * given buffer. (Little endian)
	 * @param buffer The buffer to use.
	 * @param index The index into the buffer.
	 * @param value buffer[index] = value&0xFF; buffer[index+1] = value>>>8;
	 */
	public static setWord(buffer: Buffer, index: number, value: number) {
		buffer[index]=value&0xFF;
		buffer[index+1]=value>>>8;
	}


	/**
	 * Helper method to return a WORD from two successing indices in the
	 * given buffer. (Little endian)
	 * @param buffer The buffer to use.
	 * @param index The index into the buffer.
	 * @return buffer[index] + (buffer[index+1]<<8)
	 */
	public static getWord(buffer: Buffer, index: number): number {
		const value=buffer[index]+(buffer[index+1]<<8);
		return value;
	}


	/**
	 * Returns a string (0-terminated) from the buffer.
	 * @param data The buffer.
	 * @param startIndex String conversion starts here (and ends at the next found 0.
	 */
	public static getStringFromBuffer(data: Buffer, startIndex: number): string {
		// Get string
		let result='';
		const len=data.length;
		for (let i=startIndex; i<len; i++) {
			const char=data[i];
			if (char==0)
				break;
			result+=String.fromCharCode(char);
		}
		return result;
	}


	/**
	 * Creates a string from data bytes.
	 * @param data The data buffer.
	 * @param start The start index inside the buffer.
	 * @param count The max. number of data items to show.
	 */
	public static getStringFromData(data: Buffer, start=0, count=-1): string {
		if (count==-1)
			count=data.length;
		if (start+count>data.length)
			count=data.length-start;
		if (count<=0)
			return "---";

		let result="";
		let printCount=count;
		if (printCount>300)
			printCount=300;
		for (let i=0; i<printCount; i++)
		result+=data[i+start].toString()+" ";
		if (printCount!=count)
			result+="...";
		return result;
	}


	/**
	 * Builds a condition for a breakpoint from an ASSERT expression.
	 * Simply inverts the expression by surrounding it with "!(...)".
	 * @param assertExpression E.g. "A == 7"
	 * @returns E.g. "!(A == 7)"
	 */
	public static getConditionFromAssert(assertExpression: string) {
		return '!('+assertExpression+')';
	}


	/**
	 * Strips off the "!(...)" from a breakpoint condition to
	 * display it as ASSERT expression.
	 * Does no checking, simply strips away the character position.
	 * @param bpCondition E.g. "!(A == 7)"
	 * @returns E.g. "A == 7"
	 */
	public static getAssertFromCondition(bpCondition: string|undefined) {
		if (!bpCondition)
			return '';
		let assertCond=bpCondition.substr(2);	// cut off "!("
		assertCond=assertCond.substr(0, assertCond.length-1);	// cut off trailing ")"
		return assertCond;
	}


	/**
	 * Returns a Buffer from a string. The buffer is 0-terminated.
	 * @param text A String. If 'undefined' a Buffer with just a 0 is returned.
	 * @returns A Buffer (0-terminated)
	 */
	public static getBufferFromString(text: string|undefined): Buffer {
		if (text==undefined)
			text='';
		const zeroText=text+String.fromCharCode(0);
		const buf=Buffer.from(zeroText, 'ascii');
		return buf;
	}



	/**
	 * Own assert function that additionally does a log
	 * in case of a wrong assumption.
	 */
	public static assert(test: any, message?: string) {
		if (!test) {
			try {
				throw Error(message);
			}
			catch (err) {
				// Log
				Log.log('\n!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n'+err.stack+'\n!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n');
				// Rethrow
				throw err;
			}
		}
	}


	/**
	 * An async function that waits for somee miliseconds.
	 * @param ms time to wait in ms
	 */
	public static async timeout(ms: number): Promise<void> {
		return new Promise(resolve => setTimeout(resolve, ms));
	}


	/**
	 * Returns the time since the last call to this method.
	 * If you want to measure the time some algorithm takes
	 * simply surround the algorithm by 2 calls of 'timeDiff'.
	 * Ignore the result of the first one.
	 * The result of the 2nd call is the time that has been
	 * required.
	 * ~~~
	 * timeDiff();
	 * ... your algorithm
	 * const time = timeDiff();
	 * ~~~
	 * @returns Differential time in ms.
	 */
	public static timeDiff(): number {
		const time=new Date().getMilliseconds();
		const diff=time-this.previousTimeDiffValue;
		this.previousTimeDiffValue=time;
		return diff;
	}
	static previousTimeDiffValue: number=0;


	/**
	 * Measures the time an algorithm/function takes to finish.
	 * The time is returned in ms.
	 * The algorithm is executed several times, default is 10000,
	 * to give an accurate result.
	 * ~~~
	 * const time = measure(() => {
	 *   ... your algorithm
	 *   });
	 * ~~~
	 * @param algorithm The algorithm/function to measure.
	 * @param repetitions The number of repetitions.
	 * @returns The time in ns (nano secs). The time is for one execution. I.e
	 * it is already divided by 'repetitions'.
	 */
	public static measure(algorithm: () => void, repetitions: number = 100000): number {
		const t0=new Date().getTime();
		for (let i=repetitions; i>0; i--) {
			algorithm();
		}
		const t1=new Date().getTime();
		const diff=(t1-t0)/repetitions;
		const diffns=diff*1000000;	// convert to ns
		return diffns;
	}
}

