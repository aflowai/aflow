import { describe, expect, it } from 'vitest';
import { APP_TITLE, spacePageTitle } from './page-title.js';

describe('spacePageTitle', () => {
  it('names the page and the space', () => {
    expect(spacePageTitle('/s/home/chat', 'Home')).toBe('Chat · Home · Aflow');
    expect(spacePageTitle('/s/home/computer', 'Home')).toBe('This Computer · Home · Aflow');
    expect(spacePageTitle('/s/home/settings/general', 'Home')).toBe('Settings · Home · Aflow');
    expect(spacePageTitle('/s/home/skills/drafts', 'Home')).toBe('Skills · Home · Aflow');
  });

  it('names the page alone while the space is unread', () => {
    expect(spacePageTitle('/s/home/plan', undefined)).toBe('Plan · Aflow');
  });

  it('keeps the static title for a page it does not name', () => {
    expect(spacePageTitle('/s/home', 'Home')).toBe(APP_TITLE);
    expect(spacePageTitle('/s/home/runs/r1', 'Home')).toBe(APP_TITLE);
    expect(spacePageTitle('/s/home/constructor', 'Home')).toBe(APP_TITLE);
    expect(spacePageTitle('/settings/models', 'Home')).toBe(APP_TITLE);
  });
});
