// The program that grew OpenCode's interpreter to ~3 GB in 20 seconds.
// Here a heap check runs after every ~16 MB of allocation, so it stops early.
const parts = [];
for (let i = 0; i < 1e9; i++) parts.push("x".repeat(1e6) + i);
parts.length
