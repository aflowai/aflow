import type { ConnectorCatalogEntry } from '@aflow/schemas';

const cityQueryParam = {
  name: 'q',
  location: 'query' as const,
  required: true,
  description:
    'City query — "City", "City,CountryCode", or "City,State,CountryCode" (e.g. "London", ' +
    '"London,GB", "Portland,OR,US").',
  schema: { type: 'string' },
};

const unitsParam = {
  name: 'units',
  location: 'query' as const,
  required: false,
  description:
    'Unit system for temperatures and speed: standard (Kelvin, default), metric (Celsius), or ' +
    'imperial (Fahrenheit).',
  schema: { type: 'string', enum: ['standard', 'metric', 'imperial'] },
};

const langParam = {
  name: 'lang',
  location: 'query' as const,
  required: false,
  description: 'Two-letter language code for the weather description text (e.g. "en", "de").',
  schema: { type: 'string' },
};

export const OPENWEATHER_CONNECTOR: ConnectorCatalogEntry = {
  catalogId: 'openweather',
  version: 1,
  name: 'OpenWeather',
  tagline: 'Current weather, 5-day forecast, and geocoding for any city.',
  description:
    'OpenWeather API. Fetch the current weather for a city, a 5-day / 3-hour forecast, and ' +
    'resolve a place name to coordinates via geocoding. Read-only. Authenticated with a free ' +
    'OpenWeather API key sent as the appid query parameter. Temperatures and wind can be ' +
    'returned in standard, metric, or imperial units.',
  tags: ['weather', 'forecast', 'geocoding', 'data'],
  vendor: 'OpenWeather',
  category: 'data',
  honestyLabel: 'curated',
  authKind: 'api_key',
  apiKeyQueryParamName: 'appid',
  setupNote:
    'Create a free account at openweathermap.org and copy an API key (Home → API keys). It is ' +
    'sent as the appid query parameter. A new key can take a short while to activate. Pass ' +
    'units=metric or units=imperial to control temperature units (default is Kelvin).',
  credentialPrompts: [
    {
      authField: 'credentialKey',
      label: 'OpenWeather API key',
      setupNote: 'From openweathermap.org → API keys. Sent as the appid query parameter.',
    },
  ],
  definition: {
    apiId: 'openweather',
    name: 'OpenWeather',
    description: 'OpenWeather API — current weather, 5-day forecast, and geocoding.',
    baseUrl: 'https://api.openweathermap.org',
    version: '1',
    callMode: 'endpoint',
    defaultHeaders: { Accept: 'application/json' },
    suggestedEgressPolicy: { allowedMethods: ['GET'] },
    tags: ['weather', 'forecast'],
    endpoints: [
      {
        endpointId: 'getCurrentWeather',
        name: 'Get current weather',
        description:
          'The current weather for a city — temperature, conditions, humidity, wind, and ' +
          'pressure. Resolve the city by name via the q param.',
        method: 'GET',
        pathTemplate: '/data/2.5/weather',
        params: [cityQueryParam, unitsParam, langParam],
        tags: ['weather', 'current'],
      },
      {
        endpointId: 'getForecast',
        name: 'Get 5-day forecast',
        description:
          'The 5-day weather forecast in 3-hour steps for a city — a list of dated forecast ' +
          'points with temperature and conditions.',
        method: 'GET',
        pathTemplate: '/data/2.5/forecast',
        params: [cityQueryParam, unitsParam, langParam],
        tags: ['weather', 'forecast'],
      },
      {
        endpointId: 'geocode',
        name: 'Geocode a place name',
        description:
          'Resolve a place name to coordinates — returns matching locations with their ' +
          'latitude, longitude, country, and (where available) state.',
        method: 'GET',
        pathTemplate: '/geo/1.0/direct',
        params: [
          cityQueryParam,
          {
            name: 'limit',
            location: 'query',
            required: false,
            description: 'Maximum number of matching locations to return (max 5).',
            schema: { type: 'integer', minimum: 1, maximum: 5 },
          },
        ],
        tags: ['geocoding'],
      },
    ],
  },
};
