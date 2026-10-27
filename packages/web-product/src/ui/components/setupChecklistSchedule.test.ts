// @vitest-environment jsdom
/**
 * Arming the shepherd schedule is one press: once the POST succeeds the button
 * is spent, so a second press cannot create a second schedule, and the
 * surface is told the list it shows is stale.
 */
import { act, createElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { PostInstallTask } from '@aflow/schemas';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const posted = vi.hoisted(() => ({ count: 0 }));

vi.mock('../hooks/useEdition.js', () => ({ useEdition: () => ({ id: 'community-local' }) }));
vi.mock('../hooks/useApiQuery.js', async () => {
  const { useState } = await import('react');
  return {
    useApiMutation: (opts: { onSuccess?: () => void }) => {
      const [isSuccess, setSuccess] = useState(false);
      return {
        isPending: false,
        isSuccess,
        mutate: () => {
          posted.count += 1;
          setSuccess(true);
          opts.onSuccess?.();
        },
      };
    },
  };
});
vi.mock('@aflow/design-system', () => {
  const wrapper = ({ children }: { children?: ReactNode }) => createElement('div', null, children);
  return {
    ...Object.fromEntries(
      ['Badge', 'Card', 'CardBody', 'Column', 'Row', 'Text'].map((key) => [key, wrapper]),
    ),
    Icon: () => null,
    Button: ({
      children,
      onClick,
      disabled,
    }: {
      children?: ReactNode;
      onClick?: () => void;
      disabled?: boolean;
    }) => createElement('button', { onClick, disabled }, children),
  };
});

const { SetupChecklist } = await import('./setup-checklist.js');

const SCHEDULE_TASK: PostInstallTask = {
  kind: 'shepherd_schedule',
  state: 'needs_setup',
  page: '/triggers',
  schedule: {
    agentId: '00000000-0000-4000-8000-0000000000a1',
    cronExpression: '*/5 * * * *',
    maxFirings: 50,
    inputTemplate: { input: 'tend', config: { scheduleId: { $schedule: 'id' } } },
  },
  description: 'Arm the shepherd schedule.',
  required: true,
};

describe('arming the shepherd schedule', () => {
  it('is spent after one successful press, and tells the surface its list is stale', async () => {
    const onChanged = vi.fn();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () =>
      root.render(
        createElement(SetupChecklist, {
          tasks: [SCHEDULE_TASK],
          spaceSlug: 'space',
          spaceId: 'space-id',
          onNavigate: () => undefined,
          onChanged,
        }),
      ),
    );
    const arm = () =>
      [...container.querySelectorAll('button')].find((node) =>
        node.textContent?.includes('the schedule'),
      );
    await act(async () => arm()?.click());
    expect(posted.count).toBe(1);
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(arm()).toBeUndefined();
    const spent = [...container.querySelectorAll('button')].find(
      (node) => node.textContent === 'Schedule armed',
    );
    expect(spent?.disabled).toBe(true);
    await act(async () => spent?.click());
    expect(posted.count).toBe(1);
    root.unmount();
    container.remove();
  });
});
