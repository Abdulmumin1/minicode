// A runaway loop. The interpreter spends "fuel" on every step and gives the
// host event loop a turn every millisecond, so the server stays responsive
// and the timeout stops it. (The playground uses a 3 second timeout.)
let n = 0;
while (true) n++;
