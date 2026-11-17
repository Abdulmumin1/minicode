| Program | Native V8 | OpenCode VM (Bun) | minicode (Node) | minicode (Bun) | v1 node:vm+worker |
|---|---:|---:|---:|---:|---:|
| startup (1 + 1) | 0 | 0.8 | 0.4 | 1.1 | 18.7 |
| loop 1M | 0.98 | 39.8 | 142.4 | 540.9 | 20.9 |
| fib(20) recursion | 0.11 | 2.5 | 10.5 | 34.5 | 19.2 |
| array pipeline 100k | 5.33 | 43.2 | 56.2 | 306.9 | 24.2 |
| string building 20k | 0.21 | 3.4 | 15.1 | 210 | 19.3 |
| JSON 5k objects | 2.18 | 22.3 | 9.2 | 23.1 | 21.3 |
| object churn 50k | 3.53 | 50.5 | 18.8 | 129.7 | 24.6 |
