import { describe, expect, it, vi } from 'vitest';
import { trapTabFocus } from './ui';

/**
 * Dialog focus trap. The regression this pins down: when initial focus is
 * the DIALOG CONTAINER itself (tabIndex=-1), Shift+Tab used to fall through
 * (the container passes dialog.contains(active)) and focus escaped the
 * dialog into the page behind it.
 */

type FakeNode = { name: string; focus: ReturnType<typeof vi.fn> };
const node = (name: string): FakeNode => ({ name, focus: vi.fn() });

function dialogWith(children: FakeNode[]) {
  const dialog = {
    name: 'dialog',
    focus: vi.fn(),
    contains: (n: Node | null) =>
      n === (dialog as unknown as Node) || children.includes(n as unknown as FakeNode),
  };
  return dialog;
}

const keyEvent = (shiftKey: boolean) => ({ shiftKey, preventDefault: vi.fn() });

describe('trapTabFocus', () => {
  it('REGRESSION: Shift+Tab from the focused dialog container wraps to the LAST control', () => {
    const close = node('close');
    const save = node('save');
    const dialog = dialogWith([close, save]);
    const e = keyEvent(true);
    trapTabFocus(
      e,
      dialog as never,
      [close, save] as never,
      dialog as unknown as Node, // initial focus: the container itself
    );
    expect(e.preventDefault).toHaveBeenCalled(); // never escapes the dialog
    expect(save.focus).toHaveBeenCalled(); // wrapped to last
    expect(close.focus).not.toHaveBeenCalled();
  });

  it('Tab from the dialog container enters at the FIRST control', () => {
    const close = node('close');
    const save = node('save');
    const dialog = dialogWith([close, save]);
    const e = keyEvent(false);
    trapTabFocus(e, dialog as never, [close, save] as never, dialog as unknown as Node);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(close.focus).toHaveBeenCalled();
  });

  it('Shift+Tab from the first control wraps to the last', () => {
    const close = node('close');
    const save = node('save');
    const dialog = dialogWith([close, save]);
    const e = keyEvent(true);
    trapTabFocus(e, dialog as never, [close, save] as never, close as unknown as Node);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(save.focus).toHaveBeenCalled();
  });

  it('Tab from the last control wraps to the first', () => {
    const close = node('close');
    const save = node('save');
    const dialog = dialogWith([close, save]);
    const e = keyEvent(false);
    trapTabFocus(e, dialog as never, [close, save] as never, save as unknown as Node);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(close.focus).toHaveBeenCalled();
  });

  it('Tab between middle controls is left to the browser', () => {
    const a = node('a');
    const b = node('b');
    const c = node('c');
    const dialog = dialogWith([a, b, c]);
    const e = keyEvent(false);
    trapTabFocus(e, dialog as never, [a, b, c] as never, b as unknown as Node);
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it('focus that somehow left the dialog is pulled back in', () => {
    const a = node('a');
    const outside = node('outside');
    const dialog = dialogWith([a]);
    const e = keyEvent(false);
    trapTabFocus(e, dialog as never, [a] as never, outside as unknown as Node);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(a.focus).toHaveBeenCalled();
  });

  it('a dialog with no focusable children keeps focus on the container', () => {
    const dialog = dialogWith([]);
    const e = keyEvent(true);
    trapTabFocus(e, dialog as never, [] as never, dialog as unknown as Node);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(dialog.focus).toHaveBeenCalled();
  });
});
