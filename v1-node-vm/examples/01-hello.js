// Plain JavaScript works. `return` sends a value back to the host.
console.log("hello from inside the sandbox");
const squares = [1, 2, 3, 4].map((n) => n * n);
return { squares, total: squares.reduce((a, b) => a + b, 0) };
