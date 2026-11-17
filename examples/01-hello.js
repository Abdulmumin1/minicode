// Plain JavaScript. With no `return`, the last expression is the result.
const squares = [1, 2, 3, 4].map((n) => n * n);
console.log("squares:", squares);
({ squares, total: squares.reduce((a, b) => a + b, 0) })
