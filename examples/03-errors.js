// Tool failures are ordinary errors. allSettled keeps going when one fails.
const cities = ["Lagos", "Abuja", "", "Nairobi"];
const results = await Promise.allSettled(cities.map((city) => tools.weather.get({ city })));

for (const [i, r] of results.entries()) {
  if (r.status === "rejected") console.warn(`city #${i}:`, r.reason.message);
}

const ok = results.filter((r) => r.status === "fulfilled").map((r) => r.value);
return ok.toSorted((a, b) => b.tempC - a.tempC).map((w) => `${w.city}: ${w.tempC}°C, ${w.sky}`);
