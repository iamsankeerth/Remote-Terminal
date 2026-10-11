import { useState, useCallback } from 'react';

const KEYS = [
  { label: 'Esc', data: '\u001b' },
  { label: 'Tab', data: '\t' },
  { label: 'Ctrl', data: '', toggle: true },
  { label: 'Alt', data: '', toggle: true },
  { label: 'Enter', data: '\r' },
  { label: 'Bksp', data: '\u007f' },
  { label: '\u2191', data: '\u001b[A' },
  { label: '\u2193', data: '\u001b[B' },
  { label: '\u2190', data: '\u001b[D' },
  { label: '\u2192', data: '\u001b[C' },
  { label: '|', data: '|' },
  { label: '/', data: '/' },
  { label: '~', data: '~' },
  { label: '-', data: '-' },
  { label: '.', data: '.' },
];

/** Ctrl plus a printable key: Ctrl+A is 0x01 through Ctrl+Z at 0x1a. */
const CTRL_PUNCTUATION = {
  '[': '\u001b',
  ']': '\u001d',
  '\\': '\u001c',
  '^': '\u001e',
  '/': '\u001f',
  ' ': '\u0000',
};

export function ExtraKeys({ onSend, collapsed = false, onToggleCollapsed }) {
  const [ctrlActive, setCtrlActive] = useState(false);
  const [altActive, setAltActive] = useState(false);

  const sendKey = useCallback(
    (data) => {
      let out = data;
      if (ctrlActive && out.length === 1) {
        const upper = out.toUpperCase();
        const code = upper.charCodeAt(0);
        if (code >= 65 && code <= 90) {
          out = String.fromCharCode(code - 64);
        } else if (CTRL_PUNCTUATION[out]) {
          out = CTRL_PUNCTUATION[out];
        }
        setCtrlActive(false);
      }
      if (altActive) {
        out = `\u001b${out}`;
        setAltActive(false);
      }
      if (out) onSend(out);
    },
    [ctrlActive, altActive, onSend],
  );

  return (
    <div className={`extra-keys${collapsed ? ' collapsed' : ''}`} role="toolbar" aria-label="Special keys">
      <button
        type="button"
        className="extra-key toggle-collapse"
        onClick={() => onToggleCollapsed?.(!collapsed)}
        aria-expanded={!collapsed}
        aria-label={collapsed ? 'Show special keys' : 'Hide special keys'}
      >
        {collapsed ? '\u25b8' : '\u25be'}
      </button>
      {KEYS.map((key) => {
        const isActive = (key.label === 'Ctrl' && ctrlActive) || (key.label === 'Alt' && altActive);
        const ariaLabel = key.toggle
          ? `${key.label} modifier${isActive ? ' (active)' : ''}`
          : `${key.label} key`;
        return (
          <button
            key={key.label}
            type="button"
            className={`extra-key${isActive ? ' toggle-active' : ''}`}
            onClick={() => {
              if (key.label === 'Ctrl') {
                setCtrlActive((v) => !v);
                setAltActive(false);
                return;
              }
              if (key.label === 'Alt') {
                setAltActive((v) => !v);
                setCtrlActive(false);
                return;
              }
              sendKey(key.data);
            }}
            aria-label={ariaLabel}
            aria-pressed={key.toggle ? isActive : undefined}
          >
            {key.label}
          </button>
        );
      })}
    </div>
  );
}

export default ExtraKeys;
