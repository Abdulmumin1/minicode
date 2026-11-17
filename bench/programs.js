// The same programs run on every runtime being compared.
export const programs = {
  "startup (1 + 1)": "1 + 1",
  "loop 1M": "let s = 0; for (let i = 0; i < 1000000; i++) s += i; s",
  "fib(20) recursion": "const fib = (n) => n < 2 ? n : fib(n - 1) + fib(n - 2); fib(20)",
  "array pipeline 100k": "Array.from({ length: 100000 }, (_, i) => i).map((x) => x * 2).filter((x) => x % 3 === 0).reduce((a, b) => a + b, 0)",
  "string building 20k": "let s = ''; for (let i = 0; i < 20000; i++) s += String(i % 10); s.length",
  "JSON 5k objects": "const o = Array.from({ length: 5000 }, (_, i) => ({ id: i, name: 'n' + i, tags: ['a', 'b'] })); JSON.parse(JSON.stringify(o)).length",
  "object churn 50k": "const m = {}; for (let i = 0; i < 50000; i++) m['k' + (i % 1000)] = { i, sq: i * i }; Object.keys(m).length",
};
