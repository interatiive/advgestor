# Use a lightweight Node.js base image
FROM node:18-slim

# Set the working directory
WORKDIR /usr/src/app

# Copy package.json and package-lock.json (if exists)
COPY package*.json ./

# Clean npm cache and install dependencies
RUN npm cache clean --force && npm install

# Copy the rest of the application files
COPY . .

# Expose the port
EXPOSE 3000

# Command to start the server
CMD ["npm", "start"]
