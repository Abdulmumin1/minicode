// A common model mistake: starting calls without awaiting them.
// The program ends at once. notes.save is instant, so it did happen, but its
// result was never seen. weather.get was still running, so it was cut off.
tools.notes.save({ title: "draft", body: "saved, but nobody checked" });
tools.weather.get({ city: "Lagos" });
"done"
