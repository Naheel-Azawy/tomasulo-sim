LD    F6 25+ R1
LD    F2 15+ R1
MULTD F0 F2  F4
ADDD  F4 F0  F6

INIT:
OPT.IS.ADDD.clks = 3
OPT.IS.MULTD.clks = 10
OPT.RS.stations = ["load1", "load2", "load3",
                   "add1", "add2", "add3",
                   "mult1", "mult2"]
