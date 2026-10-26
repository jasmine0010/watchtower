export function displayFireName(name: string) {
  return name.replace(/[A-Za-z]+(?:[’'][A-Za-z]+)*/g, (word, offset) => {
    if (/\d/.test(name[offset - 1] || "") || /\d/.test(name[offset + word.length] || ""))
      return word;
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  });
}
export function displayDate(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf())) return "Date unavailable";
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function displayUnits(value: number, quantity: "rain" | "area" | "temperature") {
  if (!Number.isFinite(value) || (quantity !== "temperature" && value < 0)) {
    return { us: NaN, text: "Unavailable" };
  }
  let us: number;
  let usUnit: string;
  let metricUnit: string;
  if (quantity === "rain") {
    us = value / 25.4;
    usUnit = "in/hour";
    metricUnit = "mm/hour";
  } else if (quantity === "area") {
    us = value / 2.589988110336;
    usUnit = "sq mi";
    metricUnit = "km²";
  } else {
    us = (value * 9) / 5 + 32;
    usUnit = "°F";
    metricUnit = "°C";
  }
  const digits = quantity === "temperature" ? 1 : 2;
  return {
    us,
    text: `${us.toFixed(digits)} ${usUnit} (${value.toFixed(quantity === "area" ? 2 : 1)} ${metricUnit})`,
  };
}
