// This is why Code Mode is useful: one script can make many tool calls,
// in parallel, and only return the bit you care about.
// Each weather call takes ~300ms, but together they still take ~300ms.
const cities = ["Lagos", "Abuja", "London", "Nairobi", "Accra"];
const results = await Promise.allSettled(cities.map((city) => tools.weather.get({ city })));

const ok = results.filter((r) => r.status === "fulfilled").map((r) => r.value);
const warmest = ok.sort((a, b) => b.tempC - a.tempC)[0];

await tools.notes.save({ title: "warmest", body: `${warmest.city} at ${warmest.tempC}°C` });
return { warmest, noteTitles: await tools.notes.list() };
