# WhatsApp Webhook Manager

A simple application that listens for webhook requests and forwards them to multiple registered WhatsApp numbers using Baileys.

## Features

- Single WhatsApp instance with multiple recipient numbers
- Queue system for message delivery
- Web interface for managing recipients and connection
- Support for text and image messages
- Easy setup with QR code authentication
- Persistent session storage

## Prerequisites

- Node.js (v14 or higher)
- npm
- A WhatsApp account

## Installation

1. Clone this repository:
   ```
   git clone <repository-url>
   cd wawebhook
   ```

2. Install dependencies:
   ```
   npm install
   ```

3. Start the application:
   ```
   npm start
   ```
   For development with auto-restart on file changes:
   ```
   npm run dev
   ```

## Usage

1. Access the web interface at `http://localhost:3000`
2. Login with default credentials (username: `admin`, password: `admin123`)
3. Navigate to the QR Code page and scan with your WhatsApp app to connect
4. Add recipient numbers through the Recipients page
5. Send webhook requests to `http://localhost:3000/webhook` to forward messages to all active recipients

## Webhook API

### Send a Text Message

```bash
curl -X POST http://localhost:3000/webhook \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello from webhook!"}'
```

### Send an Image Message

```bash
curl -X POST http://localhost:3000/webhook \
  -H "Content-Type: application/json" \
  -d '{"type": "image", "imageUrl": "https://example.com/image.jpg", "caption": "Image caption"}'
```

## Message Queue

The application uses a queue system to handle message delivery to multiple recipients. When a webhook request is received:

1. The message is added to the queue
2. The queue processor sends the message to each active recipient
3. If any recipient fails, the system continues with the next recipient
4. A small delay is added between messages to avoid rate limiting

## Security

The web interface is protected with basic authentication. Default credentials:
- Username: `admin`
- Password: `admin123`

You can change these credentials in the `config/users.json` file.

## License

MIT 