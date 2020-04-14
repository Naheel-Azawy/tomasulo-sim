function tomasulo(code, data_init) {

    let regs = {}; // filled later
    let mem = Array(4096).fill(0);

    let clock = 0;
    let PC = 1;

    let inst_set = {
        LD:    { type: 'load',  clks: 2 },
        SD:    { type: 'store', clks: 2 },
        ADDD:  { type: 'add',   clks: 2,  run: (j, k) => j + k },
        SUBD:  { type: 'add',   clks: 2,  run: (j, k) => j - k },
        MULTD: { type: 'mult',  clks: 10, run: (j, k) => j * k },
        DIVD:  { type: 'mult',  clks: 40, run: (j, k) => j / k }
    };

    function get_type(inst) {
        return inst_set[inst.op].type;
    }

    function get_clks(inst) {
        return inst_set[inst.op].clks;
    }

    function asm(code) {
        let res = [];
        const INST_RG = /([A-Za-z\.]+)\s+([0-9RF\+\-]+)\s+([0-9RF\+\-]+)\s+([0-9RF\+\-]+)/;
        code = code.split("\n");
        let tmp;
        for (let i in code) {
            i = Number(i);
            tmp = code[i].trim();
            if (!tmp || tmp.startsWith(";")) continue;
            tmp = tmp.match(INST_RG);
            if (!tmp || !tmp[4] || !(tmp[1] in inst_set)) {
                throw new Error(`invalid instruction ${i + 1}: ${code[i]}`);
            }
            tmp = {
                op: tmp[1],
                d:  tmp[2],
                j:  tmp[3].replace(/\+/g, ''),
                k:  tmp[4]
            };
            if (Number(tmp.j) == tmp.j)
                tmp.j = Number(tmp.j);
            res.push(tmp);
        }
        for (let i in res) {
            res[i].i = i; // keeping the index
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
    let inst_status    = {}; // { inst_i: { issue, exec, write }}
    let reg_res_status = {}; // { reg: station }
    let reservation_station = {
        load1: { busy: false, time: 0, inst: {op: ''}, address: 0 },
        load2: { busy: false, time: 0, inst: {op: ''}, address: 0 },
        load3: { busy: false, time: 0, inst: {op: ''}, address: 0 },
        add1:  { busy: false, time: 0, inst: {op: ''}, vj: '', vk: '', qj: '', qk: '' },
        add2:  { busy: false, time: 0, inst: {op: ''}, vj: '', vk: '', qj: '', qk: '' },
        add3:  { busy: false, time: 0, inst: {op: ''}, vj: '', vk: '', qj: '', qk: '' },
        mult1: { busy: false, time: 0, inst: {op: ''}, vj: '', vk: '', qj: '', qk: '' },
        mult2: { busy: false, time: 0, inst: {op: ''}, vj: '', vk: '', qj: '', qk: '' }
    };

    // init inst_status
    for (let i in insts) {
        inst_status[i] = { issue: 0, exec: 0, write: 0 };
    }

    // pretty strings

    function mod_s(str, len) {
        str += "";
        if (str.length < len) {
            str += " ".repeat(len - str.length);
        }
        return str;
    }

    function inst_str(inst) {
        return mod_s(inst.op, 5) + " " +
            mod_s(inst.d, 3) + " " +
            mod_s(inst.j, 3) + " " +
            mod_s(inst.k, 3);
    }

    function inst_status_str() {
        let res = "Instruction status:";
        res += "\n" + "=".repeat(res.length) + "\n";
        res += "Instruction\t\tIssue\tExec\tWrite\n";
        let z = s => s == 0 ? " " : s;
        for (let inst_i in insts) {
            if (PC - 1 == inst_i) {
                res += "> ";
            } else {
                res += "  ";
            }
            res += inst_str(insts[inst_i]) + "\t";
            if (inst_status[inst_i] != undefined) {
                res += z(inst_status[inst_i].issue) + "\t" +
                    z(inst_status[inst_i].exec) + "\t" +
                    z(inst_status[inst_i].write) + "\n";
            } else {
                res += "\n";
            }
        }
        return res;
    }

    function reservation_station_str() {
        let res = "Reservation station:";
        res += "\n" + "=".repeat(res.length) + "\n";
        res += "Name\tBusy\tTime\tAddress\tOp\tVj\tVk\tQj\tQk\n";
        for (let station in reservation_station) {
            res += station + "\t" +
                (reservation_station[station].busy ? "Yes" : "No") + "\t" +
                reservation_station[station].time + "\t";
            if (reservation_station[station].address == undefined) {
                res += "     \t" +
                    reservation_station[station].inst.op + "\t" +
                    reservation_station[station].vj + "\t" +
                    reservation_station[station].vk + "\t" +
                    reservation_station[station].qj + "\t" +
                    reservation_station[station].qk + "\n";
            } else {
                res += reservation_station[station].address + "\n";
            }
        }
        return res;
    }

    function reg_res_status_str() {
        let res = "Register result status:";
        res += "\n" + "=".repeat(res.length) + "\n";
        let arr = [];
        for (let r in regs) {
            if (r.startsWith("F")) {
                arr.push(`${r}: ${reg_res_status[r] != undefined ? reg_res_status[r] : '-'}`);
            }
        }
        res += arr.join(" | ") + "\n";
        return res;
    }

    function reg_file_str() {
        let res = "Register file:";
        res += "\n" + "=".repeat(res.length) + "\n";
        let arr = [];
        for (let r in regs) {
            arr.push(`${r}: ${regs[r]}`);
        }
        res += arr.join(" | ") + "\n";
        return res;
    }

    function all_str() {
        return `>>> CK: ${clock}, PC: ${PC}\n` +
            inst_status_str() + "\n" +
            reservation_station_str() + "\n" +
            reg_res_status_str() + "\n" +
            reg_file_str() + "\n" +
            "#########################################################\n\n";
    }

    // tomasulo steps

    function issue(inst) {
        // update instructions status
        inst_status[inst.i].issue = clock;

        // add to reservation station
        for (let station in reservation_station) {
            if (station.startsWith(get_type(inst))) { // station type match
                if (!reservation_station[station].busy) { // free station found

                    inst.station = station;
                    reservation_station[station].busy = true;
                    reservation_station[station].inst = inst;
                    if (reservation_station[station].address != undefined) { // store or load
                        reservation_station[station].address = inst.j + regs[inst.k];
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
                    reg_res_status[inst.d] = station;
                    break;
                }
            }
        }
    }

    function exec(inst) {
        // update instructions status
        inst_status[inst.i].exec = clock;

        // push a lambda to be executed in the next clock
        // simulating the writeback
        if (inst.queue == undefined) {
            inst.queue = [];
        }
        inst.queue.push(() => {
            switch (get_type(inst)) {
            case "load":
                regs[inst.d] = mem[reservation_station[inst.station].address];
                break;
            case "store":
                mem[reservation_station[inst.station].address] = regs[inst.d];
                break;
            default:
                if (inst.station == undefined) {
                    throw new Error(`Instruction '${inst_str(inst)}' is not in any station`);
                }
                // exec won't be called before vj and vk are ready
                let j = reservation_station[inst.station].vj;
                let k = reservation_station[inst.station].vk;
                regs[inst.d] = inst_set[inst.op].run(j, k);
                break;
            }
        });
    }

    function write(inst) {
        // run the needed operation
        inst.queue.shift()();
        
        // update instructions status
        inst_status[inst.i].write = clock;

        // clean the reservation station
        reservation_station[inst.station].busy = false;
        reservation_station[inst.station].time = 0;
            reservation_station[inst.station].inst = {op: ''};
        if (reservation_station[inst.station].address != undefined) {
            reservation_station[inst.station].address = 0;
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
    let out = "";
    out += all_str();
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
            
            // program ends after writing the result of the last instruction
            if (inst.i == insts.length - 1) {
                break;
            }
        }

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

        // issue
        if (PC <= insts.length) {
            issue(insts[PC - 1]);
            ++PC;
        }

        // start the timer for a station once both operands are ready
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
                if (reservation_station[station].address != undefined ||
                    (reservation_station[station].vj !== '' &&
                     reservation_station[station].vk !== '')) {
                    reservation_station[station].time =
                        get_clks(reservation_station[station].inst);
                    reservation_station[station].started = true;
                }
            }
        }

        out += all_str();

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

    }

    return out;
}

function run_test() {
    console.log(tomasulo(`
LD    F6  34+ R2
LD    F2  45+ R3
MULTD F0  F2  F4
SUBD  F8  F6  F2
DIVD  F10 F0  F6
ADDD  F6  F8  F2
`, (M, R, instruction_set) => {
    M[34] = 666;
    M[45] = 555;
    R.F4  = 2;
    instruction_set.DIVD.clks = 30;
}));
}

//run_test();
