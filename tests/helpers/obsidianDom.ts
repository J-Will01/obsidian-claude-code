type DomElementInfo = {
  cls?: string | string[];
  text?: string;
  attr?: Record<string, string | number | boolean>;
  type?: string;
};

function applyDomInfo(el: HTMLElement, info?: DomElementInfo | string): void {
  if (!info) {
    return;
  }

  if (typeof info === "string") {
    const classes = info.split(/\s+/).filter(Boolean);
    if (classes.length > 0) {
      el.classList.add(...classes);
    }
    return;
  }

  const classNames = Array.isArray(info.cls) ? info.cls : info.cls ? info.cls.split(/\s+/) : [];
  const classes = classNames.filter(Boolean);
  if (classes.length > 0) {
    el.classList.add(...classes);
  }

  if (info.text !== undefined) {
    el.textContent = info.text;
  }

  if (info.type) {
    el.setAttribute("type", String(info.type));
  }

  if (info.attr) {
    for (const [key, value] of Object.entries(info.attr)) {
      el.setAttribute(key, String(value));
    }
  }
}

export function installObsidianDomShim(): void {
  const proto = HTMLElement.prototype as any;

  if (!proto.empty) {
    proto.empty = function empty(this: HTMLElement): void {
      this.innerHTML = "";
    };
  }

  if (!proto.setText) {
    proto.setText = function setText(this: HTMLElement, text: string): void {
      this.textContent = text;
    };
  }

  if (!proto.addClass) {
    proto.addClass = function addClass(this: HTMLElement, ...classNames: string[]): void {
      const classes = classNames.flatMap((value) => value.split(/\s+/)).filter(Boolean);
      if (classes.length > 0) {
        this.classList.add(...classes);
      }
    };
  }

  if (!proto.removeClass) {
    proto.removeClass = function removeClass(this: HTMLElement, ...classNames: string[]): void {
      const classes = classNames.flatMap((value) => value.split(/\s+/)).filter(Boolean);
      if (classes.length > 0) {
        this.classList.remove(...classes);
      }
    };
  }

  if (!proto.toggleClass) {
    proto.toggleClass = function toggleClass(this: HTMLElement, className: string, force?: boolean): void {
      if (force === undefined) {
        this.classList.toggle(className);
      } else {
        this.classList.toggle(className, force);
      }
    };
  }

  if (!proto.createEl) {
    proto.createEl = function createEl<K extends keyof HTMLElementTagNameMap>(
      this: HTMLElement,
      tag: K,
      info?: DomElementInfo | string,
      callback?: (el: HTMLElementTagNameMap[K]) => void
    ): HTMLElementTagNameMap[K] {
      const el = document.createElement(tag);
      applyDomInfo(el, info);
      this.appendChild(el);
      callback?.(el as HTMLElementTagNameMap[K]);
      return el as HTMLElementTagNameMap[K];
    };
  }

  if (!proto.createDiv) {
    proto.createDiv = function createDiv(
      this: HTMLElement,
      info?: DomElementInfo | string,
      callback?: (el: HTMLDivElement) => void
    ): HTMLDivElement {
      return this.createEl("div", info, callback);
    };
  }

  if (!proto.createSpan) {
    proto.createSpan = function createSpan(
      this: HTMLElement,
      info?: DomElementInfo | string,
      callback?: (el: HTMLSpanElement) => void
    ): HTMLSpanElement {
      return this.createEl("span", info, callback);
    };
  }
}
