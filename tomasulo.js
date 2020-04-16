function tomasulo_with_errors(code, out_arr) {

    // In case of errors, halt after this many clocks
    const MAX_CLOCKS = 1000;

    // remove comments
    code = code.replace(/\/\/.*/g, "");

    // cleanup input
    code = code.split("INIT:");
    let data_init = undefined;
    let data_init_str = "";
    if (code.length == 2) { // data init block
        data_init_str = code[1].trim();
        data_init = (M, R, OPT) => eval(data_init_str);
    }
    code = code[0].trim();

    let regs = {}; // filled later
    let mem = Array(4096).fill(0);

    let clock = 0;
    let PC = 1;

    let inst_set = {
        LD:    { type: "load",  clks: 2 },
        SD:    { type: "store", clks: 2 },
        ADDD:  { type: "add",   clks: 2,  run: (j, k) => j + k },
        SUBD:  { type: "add",   clks: 2,  run: (j, k) => j - k },
        MULTD: { type: "mult",  clks: 10, run: (j, k) => j * k },
        DIVD:  { type: "mult",  clks: 40, run: (j, k) => j / k },
        ADDI:  { type: "basic", clks: 1,  run: (j, k, d) => regs[d] = regs[j] + k },
        SUBI:  { type: "basic", clks: 1,  run: (j, k, d) => regs[d] = regs[j] - k },
        BNE:   { type: "basic", clks: 1,  run: (j, k, d) => {if (regs[d] != regs[j]) PC = k + 1;} },
        NOP:   { type: "basic", clks: 1,  run: () => {} }
    };

    function get_type(inst) {
        return inst_set[inst.op].type;
    }

    function get_clks(inst) {
        if (Array.isArray(inst_set[inst.op].clks)) {
            if (inst_set[inst.op].clks.length == 1) {
                inst_set[inst.op].clks = inst_set[inst.op].clks[0];
            } else {
                return inst_set[inst.op].clks.shift();
            }
        }
        return inst_set[inst.op].clks;
    }

    function copy(o) {
        return JSON.parse(JSON.stringify(o));
    }

    function asm(code) {
        let res = [];
        const INST_RG = /([A-Za-z\.]+)\s+([0-9RF\+\-\#]+)\s+([0-9RF\+\-\#]+)\s+([0-9RF\+\-\#]+)/;
        code = code.split("\n");
        let tmp;
        for (let i in code) {
            i = Number(i);
            tmp = code[i].trim();
            if (!tmp || tmp.startsWith(";")) continue;
            tmp = tmp.match(INST_RG);
            if (!tmp || tmp[4] == undefined || !(tmp[1] in inst_set)) {
                throw new Error(`invalid instruction ${i + 1}: ${code[i]}`);
            }
            tmp = {
                op: tmp[1],
                d:  tmp[2],
                j:  tmp[3].replace(/[\+\#]/g, ''),
                k:  tmp[4].replace(/[\+\#]/g, '')
            };
            if (Number(tmp.j) == tmp.j)
                tmp.j = Number(tmp.j);
            if (Number(tmp.k) == tmp.k)
                tmp.k = Number(tmp.k);
            res.push(tmp);
        }
        for (let i in res) {
            res[i].i = Number(i); // keeping the index
        }
        return res;
    }

    let insts = asm(code);

    // init registers
    let tmp_regs = [];
    for (let inst of insts) {
        for (let r of [inst.d, inst.j, inst.k]) {
            if (typeof r == "string" && (r.startsWith('F') || r.startsWith('R'))) {
                tmp_regs.push(r);
            }
        }
    }
    tmp_regs.sort();
    for (let r of tmp_regs) {
        regs[r] = 0;
    }

    // tomasulto stuff
    let inst_status    = {}; // { "i_clock": { inst, issue, exec, write }}
    let reg_res_status = {}; // { reg: station }
    let reservation_station = { // filled later
        stations: [ "load1", "load2", "load3",
                    "store1", "store2", "store3",
                    "add1", "add2", "add3",
                    "mult1", "mult2" ]
    };

    function push_inst(inst) {
        inst_status[inst.i] = {
            inst: inst, issue: 0, exec: 0, write: 0
        };
    }

    // pretty strings

    function s(str="", len=7) {
        if (str == undefined) {
            str = "-";
        } else if (str !== '' && Number(str) == str) {
            str = +Number(str).toFixed(2);
        }
        str += "";
        if (str.length < len) {
            str += " ".repeat(len - str.length);
        }
        return str;
    }

    function line_str(str) {
        return str.trim().replace(/ \| /g, '-+-')
            .replace(/[A-Za-z\. ]/g, '-');
    }

    function inst_str(inst) {
        return s(inst.op, 5) + " " +
            s(inst.d, 3) + " " +
            s(inst.j, 3) + " " +
            s(inst.k, 3);
    }

    function code_str(PC) {
        let res = "** Code\n";
        res += "#+BEGIN_SRC\n";
        for (let i in insts) {
            res += (PC - 1 == i) ? "> " : "  ";
            res += i + " " + inst_str(insts[i]) + "\n";
        }
        res += "#+END_SRC";
        return res;
    }

    function inst_status_str() {
        let res = "** Instruction status\n";
        let hdr_str = "| " + s("Instruction", 17) + " | " +
            s("Issue") + " | " +
            s("Exec") + " | " +
            s("Write") + " | " +
            s("Station") + " |";
        let line = line_str(hdr_str);
        res += line + "\n" + hdr_str + "\n" + line + "\n";
        let z = s => s == 0 ? " " : s;
        for (let i in inst_status) {
            res += "| " + s(inst_str(inst_status[i].inst), 17) + " | " +
                s(z(inst_status[i].issue)) + " | " +
                s(z(inst_status[i].exec)) + " | " +
                s(z(inst_status[i].write)) + " | " +
                s(z(inst_status[i].inst.station)) + " |\n";
        }
        return res + line;
    }

    function reservation_station_str() {
        let res = "** Reservation station\n";
        let hdr = ["Name", "Busy", "Time", "Addr.", "Op", "Vj", "Vk", "Qj", "Qk"];
        let hdr_str = "| ";
        for (let h of hdr) {
            hdr_str += s(h) + " | ";
        }
        let line = line_str(hdr_str);
        res += line + "\n" + hdr_str + "\n" + line + "\n";
        for (let station in reservation_station) {
            res += "| " + s(station) + " | " +
                s(reservation_station[station].busy ? "Yes" : "No") + " | " +
                s(reservation_station[station].time) + " | " +
                s(reservation_station[station].address) + " | " +
                s(reservation_station[station].inst.op) + " | " +
                s(reservation_station[station].vj) + " | " +
                s(reservation_station[station].vk) + " | " +
                s(reservation_station[station].qj) + " | " +
                s(reservation_station[station].qk) + " |\n";
        }
        return res + line;
    }

    function registers_str(reg_set) {
        let res = "| ";
        let count = 0;
        for (let r in reg_set) {
            if (!isNaN(reg_set[r])) {
                reg_set[r] = +Number(reg_set[r]).toFixed(2);
            }
            res += `${r}: ${reg_set[r]} | `;
            count++;
            if (count % 7 == 0) {
                res += "\n| ";
            }
        }
        return res;
    }

    function reg_res_status_str() {
        let res = "** Register result status (Qi)\n";
        let set = {};
        for (let r in regs) {
            if (r.startsWith("F")) {
                set[r] = reg_res_status[r] != undefined ? reg_res_status[r] : '-';
            }
        }
        res += registers_str(set);
        return res;
    }

    function reg_file_str() {
        let res = "** Register file\n";
        let set = {};
        for (let r in regs) {
            set[r] = regs[r];
        }
        res += registers_str(set) + "\n";
        return res;
    }

    function all_str(PC) {
        return `* CK: ${clock}, PC: ${PC}\n` +
            code_str(PC) + "\n\n" +
            inst_status_str() + "\n\n" +
            reservation_station_str() + "\n\n" +
            reg_res_status_str() + "\n\n" +
            reg_file_str() + "\n";
    }

    // tomasulo steps

    function issue(inst) {

        // push instruction to instructions status
        push_inst(inst);

        // update instructions status
        inst_status[inst.i].issue = clock;

        // basic type instruction, reservation station not affected
        if (get_type(inst) == "basic") {
            return true;
        }

        // add to reservation station
        for (let station in reservation_station) {
            if (station.startsWith(get_type(inst))) { // station type match
                if (!reservation_station[station].busy) { // free station found

                    inst.station = station;
                    reservation_station[station].busy = true;
                    reservation_station[station].inst = inst;
                    if (station.startsWith("load") || station.startsWith("store")) { // store or load
                        reservation_station[station].vj = inst.j + regs[inst.k];
                        reservation_station[station].address = reservation_station[station].vj;

                        if (station.startsWith("store")) { // store only
                            let r = inst.d; // d is needed to be stored
                            if (reg_res_status[r] != undefined &&
                                isNaN(reg_res_status[r])) { // needs computation
                                reservation_station[station].qk = reg_res_status[r];
                            } else { // value ready
                                reservation_station[station].vk = regs[r];
                            }
                        }
                    } else { // other instructions

                        for (let operand of ['j', 'k']) {
                            let r = inst[operand];
                            if (reg_res_status[r] != undefined &&
                                isNaN(reg_res_status[r])) { // needs computation
                                reservation_station[station][`q${operand}`] = reg_res_status[r];
                            } else { // value ready
                                reservation_station[station][`v${operand}`] = regs[r];
                            }
                        }

                    }

                    // update register result status
                    if (!station.startsWith("store")) { // because store only reads
                        reg_res_status[inst.d] = station;
                    }

                    return true;
                }
            }
        }

        // faild issuing because all stations are busy
        delete inst_status[inst.i];
        return false;
    }

    function exec(inst) {
        // update instructions status
        if (get_type(inst) != "basic") {
            inst_status[inst.i].exec = clock;
        }

        // push a lambda to be executed in the next clock
        // simulating the writeback
        if (inst.queue == undefined) {
            inst.queue = [];
        }
        inst.queue.push(() => {
            let type = get_type(inst);
            if (inst.station == undefined && type != "basic") {
                throw new Error(`Instruction '${inst_str(inst)}' is not in any station`);
            }
            switch (type) {
            case "basic": {
                // non floating point operations need no extra magic
                inst_set[inst.op].run(inst.j, inst.k, inst.d);
                break;
            }
            case "load": {
                regs[inst.d] = mem[reservation_station[inst.station].address];
                break;
            }
            case "store": {
                // exec won't be called before vj and vk are ready
                let k = reservation_station[inst.station].vk;
                mem[reservation_station[inst.station].address] = k;
                break;
            }
            default: {
                // exec won't be called before vj and vk are ready
                let j = reservation_station[inst.station].vj;
                let k = reservation_station[inst.station].vk;
                regs[inst.d] = inst_set[inst.op].run(j, k);
                break;
            }
            }
        });
    }

    function write(inst) {
        // run the needed operation
        inst.queue.shift()();

        // update instructions status
        if (get_type(inst) != "basic") {
            inst_status[inst.i].write = clock;
        }

        // basic type instruction, reservation station not affected
        if (inst.station == undefined) {
            return;
        }

        // clean the reservation station
        reservation_station[inst.station].busy = false;
        reservation_station[inst.station].time = 0;
        reservation_station[inst.station].inst = {op: ''};
        reservation_station[inst.station].vj = '';
        reservation_station[inst.station].vk = '';
        reservation_station[inst.station].qj = '';
        reservation_station[inst.station].qk = '';
        if (reservation_station[inst.station].address != undefined) {
            reservation_station[inst.station].address = 0;
        }

        // update register result status
        for (let r in reg_res_status) {
            if (reg_res_status[r] == inst.station) {
                reg_res_status[r] = regs[inst.d];
            }
        }

        // move q's to v's in reservation stations if needed
        for (let station in reservation_station) {
            if (reservation_station[station].qj == inst.station) {
                reservation_station[station].qj = '';
                reservation_station[station].vj = regs[inst.d];
            }
            if (reservation_station[station].qk == inst.station) {
                reservation_station[station].qk = '';
                reservation_station[station].vk = regs[inst.d];
            }
        }
    }

    // init data provided by the user
    if (data_init) {
        data_init(mem, regs, {
            IS: inst_set,
            RS: reservation_station
        });
    }

    // build the reservation stations
    for (let station of reservation_station.stations) {
        reservation_station[station] =
                { busy: false, time: 0, inst: {op: ''}, vj: '', vk: '', qj: '', qk: '' };
        if (station.startsWith("load") || station.startsWith("store")) {
            reservation_station[station].address = 0;
        }
    }
    delete reservation_station.stations;

    // This part is questionable, is it possible to do concurrent
    // loads and stores? If yes then keep the queue undefined.
    // Otherwise define it to enable checking.
    // Note that loading from an address that a store is still
    // working on is handled separately below
    let load_store_queue; // = [];

    // start
    let out = [];
    let executed_insts = [];
    for (;;) {
        let out_str = "";
        ++clock;

        // update times in reservation stations
        for (let station in reservation_station) {
            if (reservation_station[station].time > 0) {
                --reservation_station[station].time;
            }
        }

        // write result
        while (executed_insts.length != 0) {
            let inst = executed_insts.shift();
            write(inst);

            if (load_store_queue != undefined) {
                if (get_type(inst) == "load" || get_type(inst) == "store") {
                    let i = load_store_queue.shift();
                    out_str += `shifted ${i}\n[${load_store_queue}]\n`;
                }
            }
        }

        // execute
        for (let station in reservation_station) {
            if (reservation_station[station].busy &&
                reservation_station[station].time == 0 &&
                reservation_station[station].started &&
                ((station.startsWith("load") || station.startsWith("store")) ||
                 reservation_station[station].vj !== '' &&
                 reservation_station[station].vk !== '')) {

                exec(reservation_station[station].inst);
                reservation_station[station].started = undefined;
                executed_insts.push(reservation_station[station].inst);
            }
        }

        // for printing, before it changes
        let cur_pc = PC;

        // issue (or execute if basic instruction)
        if (PC <= insts.length) {
            // a new copy of the inst with i = "i_clock"
            let inst = copy(insts[PC - 1]);
            inst.i += "_" + clock;
            if (get_type(inst) == "basic") {
                exec(inst);
                executed_insts.push(inst);
                ++PC;
            } else {
                if (issue(inst)) {
                    ++PC;
                }
            }

            // push to the load-store queue
            if (load_store_queue != undefined) {
                if (get_type(inst) == "load" || get_type(inst) == "store") {
                    load_store_queue.push(inst.i);
                    out_str += `pushed ${inst.i}\n[${load_store_queue}]\n`;
                }
            }
        }

        // start the timer for a station once:
        // (1) both operands are ready
        // (2) or it's just a load so no need to wait for operands
        timer_check: for (let station in reservation_station) {
            if (reservation_station[station].busy &&
                reservation_station[station].time == 0
               ) {
                for (let exec_inst of executed_insts) {
                    if (exec_inst.station == station) {
                        // if the stations's instruction has been executed
                        // and is waiting to write
                        continue timer_check;
                    }
                }

                // avoids load when an older store on the same address is still not done
                if (station.startsWith("load")) {
                    for (let station2 in reservation_station) {
                        if (reservation_station[station2].inst.i != undefined &&
                            station2.startsWith("store")) {
                            if (reservation_station[station2].busy &&
                                inst_status[reservation_station[station2].inst.i].write == 0 &&
                                inst_status[reservation_station[station2].inst.i].issue <
                                inst_status[reservation_station[station].inst.i].issue&&
                                reservation_station[station2].address ==
                                reservation_station[station].address) {

                                continue timer_check;
                            }
                        }
                    }
                }

                // if not the head of the load-store queue
                if (load_store_queue != undefined) {
                    if (station.startsWith("load") || station.startsWith("store")) {
                        out_str += `>>>>>>[${load_store_queue}]\n`;
                        out_str += reservation_station[station].inst.i + "\n" + station + "\n";
                    }
                    if (load_store_queue.length != 1 &&
                        (station.startsWith("load") || station.startsWith("store")) &&
                        reservation_station[station].inst.i !=
                        load_store_queue[0]) {
                        continue;
                    }
                }

                if (station.startsWith("load") || // (2)
                    (station.startsWith("store") &&
                     reservation_station[station].vk !== '') ||
                    (reservation_station[station].vj !== '' && // (1)
                     reservation_station[station].vk !== '')) {

                    reservation_station[station].time =
                        get_clks(reservation_station[station].inst);
                    reservation_station[station].started = true;
                }
            }
        }

        // pretty print
        out.push(out_str + all_str(cur_pc));

        // check if done executing
        let all_written = true;
        for (let i in inst_status) {
            if (inst_status[i].write == 0) {
                all_written = false;
                break;
            }
        }
        if (all_written) {
            break;
        }

        // in case took too long (probably something goes wrong)
        if (clock >= MAX_CLOCKS) {
            out.push(`* ERROR: Took ${MAX_CLOCKS} clock cycles! Halting...`);
            break;
        }

    }

    if (out_arr) {
        return out;
    } else {
        return out.join("");
    }
}

function tomasulo(code, out_arr) {
    try {
        return tomasulo_with_errors(code, out_arr);
    } catch (msg) {
        return out_arr ? [msg] : msg;
    }
}

let tomasulo_examples = {
    example0: `
LD    F0  0   R1
MULTD F0  F0  F2
SD    F0  0   R1
SUBI  R5  R5  #8
BNE   R5  R0   0 // loop

// the "INIT" block can be used optionally
// to configure the environment
INIT:
// initialize registers and memory
R.R0 = 0
R.R1 = 1000
R.R5 = 24
R.F2 = 1.11723
M[1000] = 2010

// custom time for instructions
OPT.IS.MULTD.clks = 1
// first load takkes 4,
// the rest 1 clock cycles
OPT.IS.LD.clks = [4, 1]

// customize reservation stations
OPT.RS.stations = ["load1", "load2",
                   "store1", "store2",
                   "add1", "add2", "add3",
                   "mult1", "mult2"]
`,

    example1: `
LD    F6  34+ R2
LD    F2  45+ R3
MULTD F0  F2  F4
SUBD  F8  F6  F2
DIVD  F10 F0  F6
ADDD  F6  F8  F2

INIT:
M[34] = 666
M[45] = 555
`,

    example2: `
LD    F6  34+ R2
LD    F2  45+ R3
MULTD F0  F2  F4
SD    F0  0   R5
ADDI  R6  R5  #793
SUBD  F8  F6  F2
DIVD  F10 F0  F6
ADDD  F6  F8  F2

INIT:
M[34] = 666
M[45] = 555
R.R5 = 2010
R.F4 = 2
OPT.IS.DIVD.clks = 30
`
};

// node js interface
if (typeof(module) != 'undefined') {
    module.exports = tomasulo;

    // if called from command line with a file arg
    if (process.argv.length >= 2) {
        const fs = require("fs");

        function help() {
            console.log("USAGE: node tomasulo.js [OPTIONS]... [FILE]");
            console.log("The following options are supported:");
            console.log("  -e <EXAMPLE>   run one of the existing examples");
            console.log("  -h, --help     display this help and exit");
            console.log("Available examples:");
            for (let e in tomasulo_examples) {
                console.log("  " + e);
            }
        }

        switch (process.argv[2]) {
        case "-h":
        case "--help":
            help();
            break;
        case "-e":
            if (process.argv.length == 4) {
                let e = process.argv[3];
                if (e) {
                    console.log(`* Running example '${e}'`);
                    console.log("=======================");
                    console.log(tomasulo_examples[e]);
                    console.log("=======================\n");
                    console.log(tomasulo(tomasulo_examples[e]));
                } else {
                    console.log(`* ERROR: No example named '${e}' found`);
                    help();
                }
            } else {
                help();
            }
            break;
        default:
            if (fs.existsSync(process.argv[2])) {
                console.log(tomasulo(
                    fs.readFileSync(process.argv[2]).toString()
                ));
            } else {
                help();
            }
        }

    }
}
