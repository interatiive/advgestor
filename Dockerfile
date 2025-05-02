# Use a specific version of the lightweight Node.js base image
FROM node:18.20-slim

# Set the working directory
WORKDIR /usr/src/app

# Copy all application files
COPY . .

# Install essential build tools and clean up
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Clean npm cache and install dependencies
RUN npm cache clean --force && npm install --production

# Expose the port
EXPOSE 3000

# Command to start the server
CMD ["npm", "start"]
