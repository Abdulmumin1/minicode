// Tool errors become normal JS errors you can catch.
try {
  await tools.weather.get({});
} catch (e) {
  console.warn("caught:", e.message);
}

// Uncaught errors end the run and come back as the error.
await tools.math.divide({ a: 1, b: 0 }); // there is no divide tool
