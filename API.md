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

The JSON data will be automatically formatted into a readable message with proper formatting, emojis, and structure instead of raw JSON.

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

##### 5. Image Message

```json
{
  "type": "image",
  "imageUrl": "https://example.com/image.jpg",
  "caption": "This is an image caption"
}
```

- `type`: Message type (optional, defaults to text if not specified)
  - `text`: Simple text message
  - `json`: Structured JSON data
  - `order`: Order information
  - `alert`: System alert
  - `image`: Image with caption
- `message`: Text message to send (for text messages)
- `imageUrl`: URL of the image to send (for image messages)
- `caption`: Caption for the image (optional, for image messages)

All structured data (JSON, order, alert) will be automatically formatted into readable, well-structured messages with proper formatting and emojis instead of raw JSON.

#### Response

Success:

```json
{
  "success": true,
  "message": "Webhook processed and forwarded to WhatsApp"
}
```

Error:

```json
{
  "success": false,
  "message": "Error message",
  "error": "Detailed error information"
}
```

## Error Codes

- `200`: Success
- `400`: Bad request (invalid payload)
- `500`: Server error (WhatsApp not connected, message sending failed, etc.)

## Examples

### cURL Examples

#### Sending a Text Message

```bash
curl -X POST http://localhost:3000/webhook \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello from webhook!"}'
```

#### Sending a System Notification (JSON)

```bash
curl -X POST http://localhost:3000/webhook \
  -H "Content-Type: application/json" \
  -d '{
    "type": "json",
    "title": "System Notification",
    "status": "success",
    "timestamp": "2023-08-15T12:34:56Z",
    "source": "API Server",
    "data": {
      "key1": "value1",
      "key2": "value2"
    }
  }'
```

#### Sending an Order Confirmation

```bash
curl -X POST http://localhost:3000/webhook \
  -H "Content-Type: application/json" \
  -d '{
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
    "paymentMethod": "Credit Card"
  }'
```

#### Sending a System Alert

```bash
curl -X POST http://localhost:3000/webhook \
  -H "Content-Type: application/json" \
  -d '{
    "type": "alert",
    "alertLevel": "critical",
    "system": "Database Server",
    "message": "High CPU usage detected",
    "timestamp": "2023-08-15T12:34:56Z",
    "metrics": {
      "cpu": "92%",
      "memory": "87%"
    }
  }'
```

#### Sending an Image

```bash
curl -X POST http://localhost:3000/webhook \
  -H "Content-Type: application/json" \
  -d '{"type": "image", "imageUrl": "https://picsum.photos/200/300", "caption": "Random image"}'
```

#### Checking Server Health

```bash
curl -X GET http://localhost:3000/health
``` 