/**
 * Curated applet listings — the raw entries the store registry wraps into
 * `kind: 'applet'` catalog entries. Curated-in only (Plan 264 P10): this
 * module is the sole source of applet listings; no runtime path writes here.
 */
import type { CatalogAppletPayload } from '@aflow/schemas';
import { CHESS_CATALOG_PIN, CHESS_DEFINITION, CHESS_VIEW_SOURCE } from '../appletFixtures/chess.js';
import { FILM_CATALOG_PIN, FILM_DEFINITION, FILM_VIEW_SOURCE } from '../appletFixtures/film.js';
import {
  WORK_BOARD_CATALOG_PIN,
  WORK_BOARD_DEFINITION,
  WORK_BOARD_VIEW_SOURCE,
} from '../appletFixtures/workBoard.js';

export interface AppletCatalogListing {
  catalogId: string;
  version: number;
  name: string;
  tagline: string;
  description: string;
  tags: string[];
  hidden?: boolean;
  payload: CatalogAppletPayload;
}

export const APPLET_CATALOG: readonly AppletCatalogListing[] = [
  {
    catalogId: WORK_BOARD_DEFINITION.appletKey,
    version: 2,
    name: WORK_BOARD_DEFINITION.name,
    tagline: 'A shared board the whole space works — humans and the agent, through the same moves.',
    description: WORK_BOARD_DEFINITION.description,
    tags: ['applet', 'collaboration', 'board'],
    payload: {
      appletDefinition: WORK_BOARD_DEFINITION,
      viewSource: WORK_BOARD_VIEW_SOURCE,
      artifactKind: 'applet',
      catalogPin: { ...WORK_BOARD_CATALOG_PIN },
    },
  },
  {
    catalogId: CHESS_DEFINITION.appletKey,
    version: 7,
    name: CHESS_DEFINITION.name,
    tagline: 'Standard chess for the space — humans and the agent play through the same moves.',
    description: CHESS_DEFINITION.description,
    tags: ['applet', 'game', 'chess'],
    payload: {
      appletDefinition: CHESS_DEFINITION,
      viewSource: CHESS_VIEW_SOURCE,
      artifactKind: 'applet',
      catalogPin: { ...CHESS_CATALOG_PIN },
    },
  },
  {
    catalogId: FILM_DEFINITION.appletKey,
    version: 14,
    name: FILM_DEFINITION.name,
    tagline: 'A film the room edits together — the project state is the edit decision list.',
    description: FILM_DEFINITION.description,
    tags: ['applet', 'video', 'production', 'collaboration'],
    payload: {
      appletDefinition: FILM_DEFINITION,
      viewSource: FILM_VIEW_SOURCE,
      artifactKind: 'applet',
      catalogPin: { ...FILM_CATALOG_PIN },
    },
  },
];
