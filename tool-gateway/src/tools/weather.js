// ─────────────────────────────────────────────────────────────
// Weather tool — current conditions and forecast
//
// Uses Open-Meteo API (completely free, no API key needed)
// and their geocoding API for location lookup.
//
// Tools:
//   weather_get — current weather + forecast for a location
// ─────────────────────────────────────────────────────────────

const FETCH_TIMEOUT_MS = 10000;
const { z } = require("zod");

// WMO weather interpretation codes → human-readable
const WMO_CODES = {
  0: "Clear sky",
  1: "Mainly clear",
  2: "Partly cloudy",
  3: "Overcast",
  45: "Fog",
  48: "Depositing rime fog",
  51: "Light drizzle",
  53: "Moderate drizzle",
  55: "Dense drizzle",
  56: "Light freezing drizzle",
  57: "Dense freezing drizzle",
  61: "Slight rain",
  63: "Moderate rain",
  65: "Heavy rain",
  66: "Light freezing rain",
  67: "Heavy freezing rain",
  71: "Slight snow",
  73: "Moderate snow",
  75: "Heavy snow",
  77: "Snow grains",
  80: "Slight rain showers",
  81: "Moderate rain showers",
  82: "Violent rain showers",
  85: "Slight snow showers",
  86: "Heavy snow showers",
  95: "Thunderstorm",
  96: "Thunderstorm with slight hail",
  99: "Thunderstorm with heavy hail",
};

function describeWeatherCode(code) {
  return WMO_CODES[code] || `Unknown (code ${code})`;
}

/**
 * Register weather tools on an MCP server.
 */
function registerWeatherTools(server) {
  server.tool(
    "weather_get",
    "Get current weather conditions and a multi-day forecast for any location. " +
      "Provide either a city/place name (geocoded automatically) or latitude/longitude coordinates. " +
      "Returns temperature, conditions, humidity, wind, and daily forecast.",
    {
      location: z
        .string()
        .optional()
        .describe(
          'City or place name (e.g., "London", "New York", "Tokyo"). ' +
            "Will be geocoded automatically. Omit if providing lat/lon."
        ),
      latitude: z
        .number()
        .optional()
        .describe("Latitude (-90 to 90). Use with longitude instead of location name."),
      longitude: z
        .number()
        .optional()
        .describe("Longitude (-180 to 180). Use with latitude instead of location name."),
      days: z
        .number()
        .optional()
        .describe("Number of forecast days (1-7, default: 3)"),
    },
    async ({ location, latitude, longitude, days }) => {
      const forecastDays = Math.min(Math.max(days || 3, 1), 7);

      try {
        // Step 1: Geocode if needed
        let lat = latitude;
        let lon = longitude;
        let placeName = location || `${lat},${lon}`;

        if (location && (lat === undefined || lon === undefined)) {
          const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1&language=en&format=json`;
          const geoResp = await fetch(geoUrl, {
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          });

          if (!geoResp.ok) {
            return {
              content: [
                {
                  type: "text",
                  text: `Geocoding failed: HTTP ${geoResp.status}`,
                },
              ],
              isError: true,
            };
          }

          const geoData = await geoResp.json();

          if (!geoData.results || geoData.results.length === 0) {
            return {
              content: [
                {
                  type: "text",
                  text: `Could not find location: "${location}". Try a different name or provide lat/lon coordinates.`,
                },
              ],
              isError: true,
            };
          }

          const place = geoData.results[0];
          lat = place.latitude;
          lon = place.longitude;
          placeName = [place.name, place.admin1, place.country]
            .filter(Boolean)
            .join(", ");
        }

        // Step 2: Fetch weather
        const weatherUrl =
          `https://api.open-meteo.com/v1/forecast?` +
          `latitude=${lat}&longitude=${lon}` +
          `&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m,wind_direction_10m` +
          `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max` +
          `&forecast_days=${forecastDays}` +
          `&timezone=auto`;

        const weatherResp = await fetch(weatherUrl, {
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });

        if (!weatherResp.ok) {
          return {
            content: [
              {
                type: "text",
                text: `Weather API failed: HTTP ${weatherResp.status}`,
              },
            ],
            isError: true,
          };
        }

        const data = await weatherResp.json();
        const current = data.current;
        const daily = data.daily;

        // Format current conditions
        const lines = [
          `# Weather for ${placeName}`,
          ``,
          `## Current Conditions`,
          `- **Temperature:** ${current.temperature_2m}°C (feels like ${current.apparent_temperature}°C)`,
          `- **Conditions:** ${describeWeatherCode(current.weather_code)}`,
          `- **Humidity:** ${current.relative_humidity_2m}%`,
          `- **Wind:** ${current.wind_speed_10m} km/h`,
          ``,
        ];

        // Format forecast
        if (daily && daily.time) {
          lines.push(`## ${forecastDays}-Day Forecast`);
          lines.push(``);

          for (let i = 0; i < daily.time.length; i++) {
            const date = daily.time[i];
            const high = daily.temperature_2m_max[i];
            const low = daily.temperature_2m_min[i];
            const code = daily.weather_code[i];
            const precip = daily.precipitation_sum[i];
            const wind = daily.wind_speed_10m_max[i];

            lines.push(
              `**${date}:** ${describeWeatherCode(code)}, ` +
                `${low}°C – ${high}°C` +
                `${precip > 0 ? `, ${precip}mm precip` : ""}` +
                `${wind > 30 ? `, wind ${wind} km/h` : ""}`
            );
          }
        }

        return {
          content: [
            {
              type: "text",
              text: lines.join("\n"),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Weather error: ${err.message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}

module.exports = { registerWeatherTools };
