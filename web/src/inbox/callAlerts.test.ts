import { describe, expect, it } from 'vitest';
import { callAlertText } from './callAlerts';

describe('callAlertText', () => {
  it('names a known caller and says who they are', () => {
    expect(callAlertText('+16135551234', 'Jane Doe', 'customer')).toEqual({ title: 'Incoming call · Jane Doe', body: 'Customer · +16135551234', tabTitle: '☎ Jane Doe' });
  });
  it('falls back to the number for an unknown caller', () => {
    expect(callAlertText('+16135551234')).toEqual({ title: 'Incoming call · +16135551234', body: 'Click to open the portal', tabTitle: '☎ +16135551234' });
  });
});
