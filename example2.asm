LD    F0  0   R1
MULTD F4  F0  F2
SD    F4  0   R1
SUBI  R1  R1  #8
BNE   R1  R0   0

INIT:
R.R1 = 16
OPT.IS.MULTD.clks = 10
OPT.RS.stations = ["load1", "load2", "load3",
                   "store1", "store2", "store3",
                   "add1", "add2", "add3",
                   "mult1", "mult2"]
