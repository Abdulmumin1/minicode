// Call tools with await. Each call is a message to the host, which runs the
// real function and sends the answer back.
const sum = await tools.math.add({ a: 2, b: 3 });
const product = await tools.math.multiply({ a: sum, b: 10 });
return { sum, product };
