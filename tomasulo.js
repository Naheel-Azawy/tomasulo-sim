function tomasulo(code, out_arr) {

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
        data_init = (M, R, IS) => eval(data_init_str);
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
    let reservation_station = {
        load1:  { busy: false, time: 0, inst: {op: ''}, address: 0 },
        load2:  { busy: false, time: 0, inst: {op: ''}, address: 0 },
        load3:  { busy: false, time: 0, inst: {op: ''}, address: 0 },
        store1: { busy: false, time: 0, inst: {op: ''}, address: 0, vj: '', qj: '' },
        store2: { busy: false, time: 0, inst: {op: ''}, address: 0, vj: '', qj: '' },
        store3: { busy: false, time: 0, inst: {op: ''}, address: 0, vj: '', qj: '' },
        add1:   { busy: false, time: 0, inst: {op: ''}, vj: '', vk: '', qj: '', qk: '' },
        add2:   { busy: false, time: 0, inst: {op: ''}, vj: '', vk: '', qj: '', qk: '' },
        add3:   { busy: false, time: 0, inst: {op: ''}, vj: '', vk: '', qj: '', qk: '' },
        mult1:  { busy: false, time: 0, inst: {op: ''}, vj: '', vk: '', qj: '', qk: '' },
        mult2:  { busy: false, time: 0, inst: {op: ''}, vj: '', vk: '', qj: '', qk: '' }
    };

    function push_inst(inst) {
        inst_status[inst.i] = {
            inst: inst, issue: 0, exec: 0, write: 0
        };
    }

    // pretty strings

    function s(str="", len=6) {
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
        for (let i in insts) {
            res += (PC - 1 == i) ? "> " : "  ";
            res += i + " " + inst_str(insts[i]) + "\n";
        }
        return res;
    }

    function inst_status_str() {
        let res = "** Instruction status\n";
        let hdr_str = "| " + s("Instruction", 17) + " | " +
            s("Issue") + " | " +
            s("Exec") + " | " +
            s("Write") + " | ";
        let line = line_str(hdr_str);
        res += line + "\n" + hdr_str + "\n" + line + "\n";
        let z = s => s == 0 ? " " : s;
        for (let i in inst_status) {
            res += "| " + s(inst_str(inst_status[i].inst), 17) + " | ";
            if (inst_status[i] != undefined) {
                res += s(z(inst_status[i].issue)) + " | " +
                    s(z(inst_status[i].exec)) + " | " +
                    s(z(inst_status[i].write)) + " |\n";
            } else {
                res += (s() + " | ").repeat(3) + "\n";
            }
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
                s(reservation_station[station].time) + " | ";
            if (reservation_station[station].address == undefined) {
                res += s("-") + " | " + // address
                    s(reservation_station[station].inst.op) + " | " +
                    s(reservation_station[station].vj) + " | " +
                    s(reservation_station[station].vk) + " | " +
                    s(reservation_station[station].qj) + " | " +
                    s(reservation_station[station].qk) + " |";
            } else {
                res += s(reservation_station[station].address) + " | ";
                if (station.startsWith("store")) {
                    res += s("-") + " | " + // op
                        s(reservation_station[station].vj) + " | " +
                        s("-") + " | " + // vk
                        s(reservation_station[station].qj) + " | " +
                        s("-") + " |";
                } else {
                    res += (s("-") + " | ").repeat(5);
                }
            }
            res += "\n";
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
        let res = "** Register result status\n";
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
                    if (reservation_station[station].address != undefined) { // store or load
                        reservation_station[station].address = inst.j + regs[inst.k];
                        if (station.startsWith("store")) { // store only
                            let r = inst.d;
                            if (reg_res_status[r] != undefined &&
                                isNaN(reg_res_status[r])) { // needs computation
                                reservation_station[station].qj = reg_res_status[r];
                            } else { // value ready
                                reservation_station[station].vj = regs[r];
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
                let j = reservation_station[inst.station].vj;
                mem[reservation_station[inst.station].address] = j;
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
        if (reservation_station[inst.station].address != undefined) {
            reservation_station[inst.station].address = 0;
            if (inst.station.startsWith("store")) {
                reservation_station[inst.station].vj = '';
                reservation_station[inst.station].qj = '';
            }
        } else {
            reservation_station[inst.station].vj = '';
            reservation_station[inst.station].vk = '';
            reservation_station[inst.station].qj = '';
            reservation_station[inst.station].qk = '';
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
        data_init(mem, regs, inst_set);
    }

    // start
    let out = [];
    let executed_insts = [];
    for (;;) {
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
        }

        /*// write result // TODO: sure?
        write_execs: for (let i in executed_insts) {
            let inst = executed_insts[i];
            // do not execute instruction that can override previous ones dest's
            for (let station2 in reservation_station) {
                if (reservation_station[station2].busy &&
                    reservation_station[station2].time != 0 &&
                    station2 != inst.station &&
                    reservation_station[station2].inst.d == inst.d) {
                    continue write_execs;
                }
            }
            executed_insts.splice(i, 1);
            write(inst);
        }*/

        // execute
        for (let station in reservation_station) {
            if (reservation_station[station].busy &&
                reservation_station[station].time == 0 &&
                reservation_station[station].started &&
                reservation_station[station].vj !== '' &&
                reservation_station[station].vk !== '') {

                exec(reservation_station[station].inst);
                reservation_station[station].started = undefined;
                executed_insts.push(reservation_station[station].inst);
            }
        }

        // for printing
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
        }

        // start the timer for a station once:
        // (1) both operands are ready
        // (2) or it's just a load so no need to wait for operands
        // (3) wait for other instructions writing to the same dest TODO: sure?
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
                if (station.startsWith("load") || // (2)
                    (reservation_station[station].vj !== '' && // (1)
                     reservation_station[station].vk !== '')) {
                    /*for (let station2 in reservation_station) { // (3)
                        if (reservation_station[station2].busy &&
                            reservation_station[station2].time != 0 &&
                            station2 != station &&
                            reservation_station[station2].inst.d ==
                            reservation_station[station].inst.d) {
                            continue timer_check;
                        }
                    }*/
                    reservation_station[station].time =
                        get_clks(reservation_station[station].inst);
                    reservation_station[station].started = true;
                }
            }
        }

        // pretty print
        out.push(all_str(cur_pc));

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

let tomasulo_examples = {
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
IS.DIVD.clks = 30
`,
    loop: `
LD    F0  0   R1
MULTD F4  F0  F2
SD    F4  0   R1
SUBI  R1  R1  #8
BNE   R1  R0   0

INIT:
R.R1 = 80
IS.MULTD.clks = 4
// 1st load takes 8 clocks (L1 cache miss) and
// 2nd load takes 1 clock (hit)
IS.LD.clks = [8, 1]
`
};

if (typeof(module) != 'undefined') {
    module.exports = tomasulo;
    console.log(tomasulo(tomasulo_examples.example1));
    //console.log(tomasulo(tomasulo_examples.loop));
}
