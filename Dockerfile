FROM node:18-alpine

# Create app directory
WORKDIR /usr/src/app

# Install app dependencies
COPY package*.json ./
RUN npm install

# Bundle app source
COPY . .

# Create sessions directory
RUN mkdir -p sessions

# Expose port from .env or default to 3000
EXPOSE 3000

# Start the application
CMD ["node", "index.js"] 