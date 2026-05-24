import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { SmsEventStatusEnum } from '@novu/stateless';
import { ValueFirstSmsProvider } from './valuefirst.provider';

describe('ValueFirstSmsProvider', () => {
  let provider: ValueFirstSmsProvider;

  beforeEach(() => {
    provider = new ValueFirstSmsProvider({
      username: 'testUser',
      password: 'testPassword',
      from: 'testFrom',
    });
    // Reset static properties
    (ValueFirstSmsProvider as any).token = null;
    (ValueFirstSmsProvider as any).tokenExpiry = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('should generate and cache bearer token correctly', async () => {
    const tokenResponse = {
      token: 'eyJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJ2Zmlyc3QifQ',
      expiryDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    };

    const successXml = `
      <MESSAGEACK>
        <GUID GUID="kb4jc4334130a5f461209l7t17" SUBMITDATE="2026-05-24" ID="1"/>
      </MESSAGEACK>
    `;

    const fetchMock = vi.fn().mockImplementation((url, options) => {
      if (url.includes('/token')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(tokenResponse),
        });
      }
      return Promise.resolve({
        ok: true,
        text: () => Promise.resolve(successXml),
      });
    });

    global.fetch = fetchMock;

    // First send: should fetch token
    const result1 = await provider.sendMessage({
      content: 'hello',
      to: '+919876543210',
    });

    expect(result1).toEqual({
      id: 'kb4jc4334130a5f461209l7t17',
      date: expect.any(String),
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.myvfirst.com/psms/api/messages/token?action=generate',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Basic dGVzdFVzZXI6dGVzdFBhc3N3b3Jk',
        }),
      })
    );

    // Second send: should use cached token
    fetchMock.mockClear();

    await provider.sendMessage({
      content: 'world',
      to: '+919876543210',
    });

    // Verify token generation was not called again
    const tokenCall = fetchMock.mock.calls.find((c) => c[0].includes('/token'));
    expect(tokenCall).toBeUndefined();

    // Verify correct Bearer token was used in the send API call
    const sendCall = fetchMock.mock.calls.find((c) => c[0].includes('Eservice2'));
    expect(sendCall).toBeDefined();
    expect(sendCall![1]?.headers?.Authorization).toBe(`Bearer ${tokenResponse.token}`);
  });

  test('should build XML payload correctly and escape special characters', async () => {
    const tokenResponse = {
      token: 'test-token',
      expiryDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    };

    const successXml = `
      <MESSAGEACK>
        <GUID GUID="test-guid" SUBMITDATE="2026-05-24" ID="1"/>
      </MESSAGEACK>
    `;

    const fetchMock = vi.fn().mockImplementation((url, options) => {
      if (url.includes('/token')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(tokenResponse),
        });
      }
      return Promise.resolve({
        ok: true,
        text: () => Promise.resolve(successXml),
      });
    });

    global.fetch = fetchMock;

    await provider.sendMessage({
      content: 'hello <world> & "friends"\'',
      to: '+91-98765-43210',
    });

    const sendCall = fetchMock.mock.calls.find((c) => c[0].includes('Eservice2'));
    expect(sendCall).toBeDefined();

    const xmlPayload = sendCall![1]?.body as string;

    // Recipient phone should have special characters stripped
    expect(xmlPayload).toContain('TO="919876543210"');
    // Content should be escaped correctly
    expect(xmlPayload).toContain('TEXT="hello &lt;world&gt; &amp; &quot;friends&quot;&apos;"');
    // Username and password should be present and escaped
    expect(xmlPayload).toContain('USERNAME="testUser"');
    expect(xmlPayload).toContain('PASSWORD="testPassword"');
  });

  test('should support DLT parameters passed via passthrough', async () => {
    const tokenResponse = {
      token: 'test-token',
      expiryDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    };

    const successXml = `
      <MESSAGEACK>
        <GUID GUID="test-guid" SUBMITDATE="2026-05-24" ID="1"/>
      </MESSAGEACK>
    `;

    const fetchMock = vi.fn().mockImplementation((url, options) => {
      if (url.includes('/token')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(tokenResponse),
        });
      }
      return Promise.resolve({
        ok: true,
        text: () => Promise.resolve(successXml),
      });
    });

    global.fetch = fetchMock;

    await provider.sendMessage(
      {
        content: 'DLT content',
        to: '919876543210',
      },
      {
        _passthrough: {
          body: {
            dltTemplateId: '120716172635467',
            entityId: '110115984635467',
            dltContentType: '1',
            templateInfo: '120716172635467~var1',
          },
        },
      }
    );

    const sendCall = fetchMock.mock.calls.find((c) => c[0].includes('Eservice2'));
    expect(sendCall).toBeDefined();

    const xmlPayload = sendCall![1]?.body as string;

    // Attributes should be correctly injected
    expect(xmlPayload).toContain('DLT_TEMPLATE_ID="120716172635467"');
    expect(xmlPayload).toContain('DLTCONTENTTYPE="1"');
    expect(xmlPayload).toContain('TEMPLATEINFO="120716172635467~var1"');
    expect(xmlPayload).toContain('ENTITYID="110115984635467"');
  });

  test('should throw a descriptive error on critical XML error', async () => {
    const tokenResponse = {
      token: 'test-token',
      expiryDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    };

    const errorXml = `
      <MESSAGEACK>
        <Err Code="52992" Desc="UserName Password Incorrect"/>
      </MESSAGEACK>
    `;

    const fetchMock = vi.fn().mockImplementation((url, options) => {
      if (url.includes('/token')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(tokenResponse),
        });
      }
      return Promise.resolve({
        ok: true,
        text: () => Promise.resolve(errorXml),
      });
    });

    global.fetch = fetchMock;

    await expect(
      provider.sendMessage({
        content: 'hello',
        to: '919876543210',
      })
    ).rejects.toThrow('ValueFirst API Error: UserName Password Incorrect (Code: 52992)');
  });

  test('should throw a descriptive error on message/sequence error', async () => {
    const tokenResponse = {
      token: 'test-token',
      expiryDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    };

    const errorXml = `
      <MESSAGEACK>
        <GUID GUID="some-guid" ID="1">
          <ERROR SEQ="1" CODE="28682"/>
        </GUID>
      </MESSAGEACK>
    `;

    const fetchMock = vi.fn().mockImplementation((url, options) => {
      if (url.includes('/token')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(tokenResponse),
        });
      }
      return Promise.resolve({
        ok: true,
        text: () => Promise.resolve(errorXml),
      });
    });

    global.fetch = fetchMock;

    await expect(
      provider.sendMessage({
        content: 'hello',
        to: '919876543210',
      })
    ).rejects.toThrow('ValueFirst Message Error: Code 28682');
  });

  test('should get message ID correctly', () => {
    const singleBody = {
      guid: 'kb4jc4334130a5f461209l7t17',
      status: 'DELIVERED',
    };
    expect(provider.getMessageId(singleBody)).toEqual(['kb4jc4334130a5f461209l7t17']);

    const arrayBody = [
      { msgid: 'guid-1', status: 'SENT' },
      { messageId: 'guid-2', status: 'DELIVERED' },
    ];
    expect(provider.getMessageId(arrayBody)).toEqual(['guid-1', 'guid-2']);
  });

  test('should parse webhook callback correctly', () => {
    const webhookBody = {
      guid: 'kb4jc4334130a5f461209l7t17',
      status: 'DELIVERED',
      attempt: '2',
      response: 'Success',
    };

    const result = provider.parseEventBody(webhookBody, 'kb4jc4334130a5f461209l7t17');

    expect(result).toEqual({
      status: SmsEventStatusEnum.DELIVERED,
      date: expect.any(String),
      externalId: 'kb4jc4334130a5f461209l7t17',
      attempts: 2,
      response: 'Success',
      row: webhookBody,
    });
  });

  test('should map DLR statuses correctly', () => {
    const parse = (status: string) => {
      const body = {
        guid: 'test-guid',
        status,
      };
      return provider.parseEventBody(body, 'test-guid');
    };

    expect(parse('DELIVERED')?.status).toBe(SmsEventStatusEnum.DELIVERED);
    expect(parse('NOT_DELIVERED')?.status).toBe(SmsEventStatusEnum.UNDELIVERED);
    expect(parse('QUEUED')?.status).toBe(SmsEventStatusEnum.QUEUED);
    expect(parse('SENT')?.status).toBe(SmsEventStatusEnum.SENT);
    expect(parse('FAILED')?.status).toBe(SmsEventStatusEnum.FAILED);
    expect(parse('REJECTED')?.status).toBe(SmsEventStatusEnum.REJECTED);
    expect(parse('UNKNOWN')).toBeUndefined();
  });
});
