import { useId, useRef, useEffect } from 'react';
import { CircleHelp } from 'lucide-react';

export function HelpTip({ label, children }: { label: string; children: string }) {
  const id = useId();
  const tip = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const reposition = () => {
      if (tip.current?.matches(':popover-open') && trigger.current) place(trigger.current);
    };
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  }, []);
  function place(button: HTMLButtonElement) {
    if (!tip.current) return;
    const rect = button.getBoundingClientRect();
    tip.current.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - 292))}px`;
    tip.current.style.top = `${Math.max(12, Math.min(rect.bottom + 8, window.innerHeight - 140))}px`;
  }
  function show(button: HTMLButtonElement) {
    place(button);
    tip.current?.showPopover();
  }
  return (
    <span className="help-tip">
      <button
        ref={trigger}
        type="button"
        className="help-button"
        aria-label={`${label}のヘルプ`}
        aria-describedby={id}
        popoverTarget={id}
        onMouseEnter={(event) => show(event.currentTarget)}
        onMouseLeave={(event) => {
          if (document.activeElement !== event.currentTarget) tip.current?.hidePopover();
        }}
        onFocus={(event) => show(event.currentTarget)}
        onBlur={() => tip.current?.hidePopover()}
        onClick={(event) => {
          event.preventDefault();
          show(event.currentTarget);
        }}
      >
        <CircleHelp size={14} aria-hidden="true" />
      </button>
      <span id={id} ref={tip} role="tooltip" popover="auto" className="help-popover">
        {children}
      </span>
    </span>
  );
}
