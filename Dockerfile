FROM node:18-alpine

# Set working directory
WORKDIR /app

# Copy package.json and package-lock.json (or pnpm/yarn equivalent)
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of the application
COPY . .

# Install TypeScript globally (optional, if not included in dev dependencies)
RUN npm install -g typescript

# Compile TypeScript
RUN npm run build

# Expose the port the app runs on
EXPOSE 3000

# Command to run the application (assuming your compiled code is in the `dist` folder)
CMD ["node", "dist/index.js"]