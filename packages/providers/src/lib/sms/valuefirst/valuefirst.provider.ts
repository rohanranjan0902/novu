import { SmsProviderIdEnum } from '@novu/shared';
import {
  ChannelTypeEnum,
  ISendMessageSuccessResponse,
  ISMSEventBody,
  ISmsOptions,
  ISmsProvider,
  SmsEventStatusEnum,
} from '@novu/stateless';
import { BaseProvider, CasingEnum } from '../../../base.provider';
import { WithPassthrough } from '../../../utils/types';

export class ValueFirstSmsProvider extends BaseProvider implements ISmsProvider {
  id = SmsProviderIdEnum.ValueFirst;
  channelType = ChannelTypeEnum.SMS as ChannelTypeEnum.SMS;
  protected casing = CasingEnum.CAMEL_CASE;

  private static token: string | null = null;
  private static tokenExpiry = 0;

  constructor(
    private config: {
      username?: string;
      password?: string;
      from?: string;
    }
  ) {
    super();
  }

  private async getBearerToken(): Promise<string> {
    const now = Date.now();
    // Refresh token if it doesn't exist, or is within 5 minutes of expiring
    if (!ValueFirstSmsProvider.token || now >= ValueFirstSmsProvider.tokenExpiry - 5 * 60 * 1000) {
      await this.refreshToken();
    }
    return ValueFirstSmsProvider.token!;
  }

  private async refreshToken(): Promise<void> {
    const username = this.config.username;
    const password = this.config.password;
    if (!username || !password) {
      throw new Error('ValueFirst provider credentials (username, password) are missing.');
    }

    const authHeader = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
    const tokenUrl = 'https://api.myvfirst.com/psms/api/messages/token?action=generate';

    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        Authorization: authHeader,
        'Content-Type': 'application/json',
      },
    } as any);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to generate ValueFirst token: ${response.statusText} (${errorText})`);
    }

    const data = await response.json();
    if (!data.token) {
      throw new Error(`ValueFirst token generation response did not contain a token: ${JSON.stringify(data)}`);
    }

    ValueFirstSmsProvider.token = data.token;

    let ttlMs = 7 * 24 * 60 * 60 * 1000; // Default 7 days
    if (data.expiryDate) {
      const expiryTime = new Date(data.expiryDate).getTime();
      if (!isNaN(expiryTime)) {
        ttlMs = expiryTime - Date.now();
      }
    }

    ValueFirstSmsProvider.tokenExpiry = Date.now() + ttlMs;
  }

  async sendMessage(
    options: ISmsOptions,
    bridgeProviderData: WithPassthrough<Record<string, unknown>> = {}
  ): Promise<ISendMessageSuccessResponse> {
    const token = await this.getBearerToken();

    const transformed = this.transform<Record<string, unknown>>(bridgeProviderData, {
      to: options.to,
      from: options.from || this.config.from,
      message: options.content,
    });

    const body = transformed.body;

    const to = String(body.to || options.to);
    // ValueFirst recipient number should be formatted (e.g. without '+')
    const formattedTo = to.replace(/[^0-9]/g, '');

    const from = String(body.from || options.from || this.config.from);
    const content = String(body.message || options.content);

    // Optional DLT properties passed via passthrough or extra payload
    const dltTemplateId = body.dltTemplateId || body.dlt_templateid || body.dltTemplateid;
    const entityId = body.entityId || body.entityid || body.peId || body.pe_id || body.peid;
    const dltContentType = body.dltContentType || body.dltcontenttype;
    const templateInfo = body.templateInfo || body.templateinfo;

    const escapeXml = (unsafe: string) => {
      return unsafe.replace(/[<>&'"]/g, (c) => {
        switch (c) {
          case '<':
            return '&lt;';
          case '>':
            return '&gt;';
          case '&':
            return '&amp;';
          case '\'':
            return '&apos;';
          case '"':
            return '&quot;';
          default:
            return c;
        }
      });
    };

    const escapedContent = escapeXml(content);
    const escapedFrom = escapeXml(from);

    let smsAttributes = `UDH="0" CODING="1" TEXT="${escapedContent}" PROPERTY="0" ID="1"`;
    if (templateInfo) {
      smsAttributes += ` TEMPLATEINFO="${escapeXml(String(templateInfo))}"`;
    }
    if (dltTemplateId) {
      smsAttributes += ` DLT_TEMPLATE_ID="${escapeXml(String(dltTemplateId))}"`;
    }
    if (dltContentType) {
      smsAttributes += ` DLTCONTENTTYPE="${escapeXml(String(dltContentType))}"`;
    }

    let addressAttributes = `FROM="${escapedFrom}" TO="${formattedTo}" SEQ="1"`;
    if (entityId) {
      addressAttributes += ` ENTITYID="${escapeXml(String(entityId))}"`;
    }

    const xmlPayload = `<?xml version="1.0" encoding="ISO-8859-1"?>
<!DOCTYPE MESSAGE SYSTEM "https://127.0.0.1:80/psms/dtd/messagev12.dtd">
<MESSAGE VER="1.2">
    <USER USERNAME="${escapeXml(this.config.username || '')}" PASSWORD="${escapeXml(this.config.password || '')}"/>
    <SMS ${smsAttributes}>
        <ADDRESS ${addressAttributes}/>
    </SMS>
</MESSAGE>`;

    const apiEndpoint = 'https://api.myvfirst.com/psms/servlet/psms.Eservice2';

    const response = await fetch(apiEndpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/xml',
      },
      body: xmlPayload,
    } as any);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`ValueFirst API HTTP error: ${response.statusText} (${errorText})`);
    }

    const responseText = await response.text();

    // Check for critical / authentication errors in XML response
    if (responseText.includes('<Err ') || responseText.includes('<Err>')) {
      const codeMatch = responseText.match(/Code="([^"]+)"/i);
      const descMatch = responseText.match(/Desc="([^"]+)"/i);
      const code = codeMatch ? codeMatch[1] : 'Unknown';
      const desc = descMatch ? descMatch[1] : 'Unknown error';
      throw new Error(`ValueFirst API Error: ${desc} (Code: ${code})`);
    }

    // Check for specific message / sequence errors
    const errorMatch = responseText.match(/<ERROR\s+[^>]*CODE="([^"]+)"/i) || responseText.match(/<ERROR\s+[^>]*Code="([^"]+)"/i);
    if (errorMatch) {
      const errorCode = errorMatch[1];
      throw new Error(`ValueFirst Message Error: Code ${errorCode}`);
    }

    // Extract Guid/messageId
    const guidMatch = responseText.match(/<GUID\s+[^>]*GUID="([^"]+)"/i);
    if (!guidMatch) {
      throw new Error(`ValueFirst API unexpected response format: ${responseText}`);
    }

    const messageId = guidMatch[1];

    return {
      id: messageId,
      date: new Date().toISOString(),
    };
  }

  getMessageId(body: any | any[]): string[] {
    if (Array.isArray(body)) {
      return body.map((item) => item.guid || item.msgid || item.messageId || item.messageid);
    }

    return [body.guid || body.msgid || body.messageId || body.messageid];
  }

  parseEventBody(body: any | any[], identifier: string): ISMSEventBody | undefined {
    if (Array.isArray(body)) {
      body = body.find((item) => {
        const id = item.guid || item.msgid || item.messageId || item.messageid;
        return id === identifier;
      });
    }

    if (!body) {
      return undefined;
    }

    const guid = body.guid || body.msgid || body.messageId || body.messageid;
    if (guid !== identifier) {
      return undefined;
    }

    const status = this.getStatus(body.status);

    if (status === undefined) {
      return undefined;
    }

    return {
      status,
      date: new Date().toISOString(),
      externalId: guid,
      attempts: body.attempt ? parseInt(body.attempt, 10) : 1,
      response: body.response ? body.response : '',
      row: body,
    };
  }

  private getStatus(status: string): SmsEventStatusEnum | undefined {
    if (!status) return undefined;
    switch (status.toUpperCase()) {
      case 'DELIVERED':
        return SmsEventStatusEnum.DELIVERED;
      case 'NOT_DELIVERED':
        return SmsEventStatusEnum.UNDELIVERED;
      case 'QUEUED':
        return SmsEventStatusEnum.QUEUED;
      case 'SENT':
        return SmsEventStatusEnum.SENT;
      case 'FAILED':
        return SmsEventStatusEnum.FAILED;
      case 'REJECTED':
        return SmsEventStatusEnum.REJECTED;
      default:
        return undefined;
    }
  }
}
