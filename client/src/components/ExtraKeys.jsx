const SPECIAL_KEYS = [
  { label: 'Esc', data: '\u001b' },
  { label: 'Tab', data: '\t' },
  { label: 'Ctrl', modifier: 'ctrl' },
  { label: 'Alt', modifier: 'alt' },
  { label: 'Enter', data: '\r' },
  { label: 'Bksp', data: '\u007f' },
  { label: '\u2191', data: '\u001b[A' },
  { label: '\u2193', data: '\u001b[B' },
  { label: '\u2190', data: '\u001b[D' },
  { label: '\u2192', data: '\u001b[C' },
  { label: '|', data: '|' },
  { label: '/', data: '/' },
  { label: '~', data: '~' },
];

const CTRL_MAP = {
  c: '\u0003',
  d: '\u0004',
  z: '\u001a',
  l: '\u000c',
  a: '\u0001',
  e: '\u0005',
  u: '\u0015',
  w: '\u0017',
  r: '\u0012',
};

/**
 * Mobile special-key toolbar. Works with the software keyboard open, collapses out of the way,
 * and sends the control sequences a phone keyboard cannot easily produce.
 */
export function ExtraKeys({ onSend }) {

  return (
    <div className={`extra-keys${collapsed ? ' collapsed' : ''}`} aria-label="Special keys">
      <button type="button" onClick={() => onSend('\t')}>Tab</button>
      <button type="button" onClick={() => onSend('\u001b')}>Esc</button>
      <button type="button" onClick={() => onSend('\r')}>Enter</button>
      <button type="button" onClick={() => onSend('\u007f')}>Bksp</button>
      {['\u2191', '\u2193', '\u2190', '\u2192'].map((arrow, index) => {
        const data = ['\u001b[A', '\u001b[B', '\u001b[D', '\u001b[C'][index];
        return (
          <button key={arrow} type="button" onClick={() => onSend(data)}>
            {arrow}
          </button>
        );
      })}
      <button type="button" onClick={() => onSend('\u0003')}>C-c</button>
      {['|', '/', '~', '-'].map((symbol) => (
        <button key={symbol} type="button" onClick={() => onSend(symbol)}>
          {symbol}
        </button>
      ))}
    </div>
  );
}

export { SPECIAL_KEYS, CTRL_MAP };
export default ExtraKeys;
