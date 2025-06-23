# WhatsApp Webhook API Documentation

This document describes the API endpoints available in the WhatsApp Webhook Forwarder application.

## Base URL

```
http://your-server:PORT
```

Where `PORT` is the port configured in your `.env` file (default: 3000).

## Endpoints

### Health Check

Check if the server is running and WhatsApp is connected.

```
GET /health
```

#### Response

```json
{
  "status": "ok",
  "whatsappConnected": true
}
```

- `status`: Server status
- `whatsappConnected`: Boolean indicating if WhatsApp client is connected

### Webhook

Send a message to the configured WhatsApp number.

```
POST /webhook
```

#### Request Body

The webhook endpoint supports different message types:

##### 1. Simple Text Message

```json
{
  "message": "This is a text message that will be forwarded to WhatsApp"
}
```

##### 2. Structured JSON Data

```json
{
  "type": "json",
  "title": "System Notification",
  "status": "success",
  "timestamp": "2023-08-15T12:34:56Z",
  "source": "API Server",
  "data": {
    "key1": "value1",
    "key2": "value2",
    "nested": {
      "key": "value"
    }
  }
}
```

The JSON data will be formatted based on your webhook settings:
- **Raw (JSON)**: The data will be sent as raw JSON text.
- **Pretty (System Default)**: The data will be automatically formatted into a readable message with proper formatting, emojis, and structure. The message title will include the source domain (e.g., "Webhook from example.com") if available.
- **Pretty (Custom Template)**: The data will be formatted according to your custom template. You can use placeholders like `{{{key_name}}}` to insert values from your webhook data.

You can configure the format type for each webhook in the webhook settings.

## Custom Templates

When using the "Pretty (Custom Template)" option, you can create custom templates for your webhook messages. Templates use placeholders in the format `{{{key_name}}}` that will be replaced with actual values from your webhook payload.

### WhatsApp Formatting

You can use WhatsApp's formatting syntax in your templates:
- **Bold**: Wrap text with asterisks `*bold*`
- **Italic**: Wrap text with underscores `_italic_`
- **Strikethrough**: Wrap text with tildes `~strikethrough~`
- **Code**: Wrap text with three backticks <code>```code```</code>

The template editor provides formatting buttons to help you apply these styles.

### Publication Status

Custom templates have a publication status:
- **Published**: The template will be used to format webhook messages.
- **Unpublished**: Webhook messages will be sent as raw JSON until the template is published. This allows you to test and verify your template before using it.

### Drag and Drop Template Builder

The webhook form includes a drag-and-drop interface to help you build custom templates:

1. First, send a real webhook to your webhook endpoint
2. Click the "Ambil Variabel dari Webhook Terakhir" (Get Variables from Last Webhook) button
3. The system will retrieve the structure of your last received webhook (variable names and types only, not actual values)
4. Drag variables from the left panel and drop them into your template
5. Customize the text around the variables to create your message format

This makes it easy to create templates based on your actual webhook data structure without having to manually type the variable placeholders.

### Privacy Note

For privacy and security reasons, the system only stores the structure of your webhook data (variable names and types), not the actual values. This ensures that sensitive data from your webhooks is not stored in our system.

### Example Template

```
📩 *Pembayaran dari {{{customer_name}}}*

🕒 *Waktu*: {{{timestamp}}}

*Jumlah*: Rp {{{amount}}}
*Status*: {{{status}}}
*Metode*: {{{payment_method}}}
```

### Placeholder Rules

1. Placeholders must be enclosed in triple curly braces: `{{{key_name}}}`
2. The key name must match exactly with the field in your webhook payload
3. For nested data, use dot notation: `{{{payment.amount}}}`
4. A special `{{{timestamp}}}` placeholder is always available with the current date and time

### Example Webhook Payload

```json
{
  "customer_name": "John Doe",
  "amount": 150000,
  "status": "success",
  "payment_method": "QRIS",
  "payment": {
    "id": "pay_123456",
    "details": "Some payment details"
  }
}
```

When this payload is processed with the example template above, the resulting message would be:

```
📩 *Pembayaran dari John Doe*

🕒 *Waktu*: 2023-08-15 12:34:56

*Jumlah*: Rp 150000
*Status*: success
*Metode*: QRIS
```

#### Source Domain Detection

When sending webhook requests, the system automatically detects the source domain from HTTP headers (`Origin` or `Referer`) and includes it in the message title. For example:

- If the webhook is sent from `https://myapp.com`, the message will start with "📩 **Webhook from myapp.com**"
- If no external source domain is detected, it will show "📩 **Webhook Notification**"

**Note:** The system excludes the webhook server's own domain to avoid showing misleading information. Only external source domains are displayed in the message title.

##### 3. Order Information

```json
{
  "type": "order",
  "orderId": "ORD-12345",
  "customerName": "John Doe",
  "orderDate": "2023-08-15T12:34:56Z",
  "status": "confirmed",
  "items": [
    { "name": "Product A", "quantity": 2, "price": 25.99 },
    { "name": "Product B", "quantity": 1, "price": 59.99 }
  ],
  "totalAmount": 111.97,
  "shippingAddress": {
    "street": "123 Main St",
    "city": "Anytown",
    "zipCode": "12345"
  },
  "paymentMethod": "Credit Card"
}
```

##### 4. System Alert

```json
{
  "type": "alert",
  "alertLevel": "critical",
  "system": "Database Server",
  "message": "High CPU usage detected",
  "timestamp": "2023-08-15T12:34:56Z",
  "metrics": {
    "cpu": "92%",
    "memory": "87%",
    "disk": "65%"
  },
  "actionRequired": true
}
```