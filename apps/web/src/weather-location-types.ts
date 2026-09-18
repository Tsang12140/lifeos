/**
 * Types shared by the offline location catalog and the Settings dropdown.
 *
 * Kept in its own module so the data file (weather-locations.data.json, emitted
 * by compile-locations.mjs) stays a pure artifact with no hand-written types
 * inside it, and so the dropdown component can import the shape without pulling
 * the whole catalog into its type surface.
 */

/** What a completed three-rung pick resolves to. */
export interface WeatherLocationOption {
  /** The QWeather Location ID to send as `locationId`. Never empty. */
  readonly locationId: string;
  /**
   * The short human label the weather header shows (e.g. 佛山南海区). Always
   * filled, so the API can re-resolve by name if the ID ever needs recovery.
   */
  readonly city: string;
  /** The province/region rung as chosen. */
  readonly province: string;
  /** The city rung as it appears in the catalog (e.g. 佛山市). */
  readonly cityName: string;
  /** The district rung, when one was chosen. */
  readonly districtName?: string;
  /**
   * True when the city rung is really its seat city's ID, because QWeather has
   * no region-wide row for that autonomous prefecture. The UI shows a hint so
   * the owner is not misled into thinking the forecast covers the whole region.
   */
  readonly seatOnly?: boolean;
}

/** One selectable rung in the ladder. */
export interface WeatherLocationRung {
  readonly id: string;
  readonly name: string;
}
