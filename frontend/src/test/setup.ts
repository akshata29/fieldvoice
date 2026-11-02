/** Vitest setup: small browser-API shims so jsdom-based component tests can render the app. */
if (typeof window !== 'undefined') {
  const w = window as unknown as Record<string, unknown>;

  if (!w.ResizeObserver) {
    w.ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
  }

  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  }

  if (typeof HTMLDialogElement !== 'undefined') {
    const proto = HTMLDialogElement.prototype as unknown as Record<string, unknown>;
    proto.showModal = function showModal(this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
    proto.show = proto.showModal;
    proto.close = function close(this: HTMLDialogElement) {
      this.removeAttribute('open');
      this.dispatchEvent(new Event('close'));
    };
  }

  window.scrollTo = (() => undefined) as typeof window.scrollTo;
  Element.prototype.scrollIntoView = () => undefined;
}
