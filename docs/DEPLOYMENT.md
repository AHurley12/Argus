# Deployment Instructions

## GitHub Pages

### Enabling GitHub Pages
1. Go to your repository on GitHub.
2. Click on `Settings`.
3. Scroll down to the `Pages` section.
4. Select the `gh-pages` branch from the dropdown.
5. Choose the root folder as the source.
6. Save the changes.

### Custom Domain
1. In the same `Pages` section, add your custom domain.
2. Configure your domain's DNS settings to point to GitHub's servers.
3. Ensure the domain is verified by GitHub after setting the DNS.

## Netlify

### Drag-and-Drop Deployment
1. Go to the Netlify website and login.
2. Drag and drop your project folder into the Netlify dashboard.
3. Wait for the deployment to finish and access your site via the generated URL.

### CLI Deployment
1. Install the Netlify CLI globally:
   ```bash
   npm install -g netlify-cli
   ```
2. Login to your Netlify account:
   ```bash
   netlify login
   ```
3. Navigate to your project directory:
   ```bash
   cd path/to/your/project
   ```
4. Initialize the deployment:
   ```bash
   netlify init
   ```
5. Deploy your site:
   ```bash
   netlify deploy
   ```

### Environment Variables
1. Go to your site settings in Netlify.
2. Navigate to the `Build & Deploy` section.
3. Click on `Environment Variables` and add your keys and values.

## Vercel

### Integration
1. Login to Vercel and select `New Project`.
2. Connect your GitHub repository.
3. Configure the project settings and deploy the project.

### Auto-Deploy
1. Vercel automatically deploys with every push to the connected repository.
2. Ensure your project settings are configured correctly for auto-deployment.

## Docker

### Dockerfile
Create a `Dockerfile` in your project root:
```Dockerfile
FROM node:14
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm install
COPY . .
EXPOSE 3000
CMD ["npm", "start"]
```

### Build and Run Commands
1. Build the Docker image:
   ```bash
   docker build -t your-image-name .
   ```
2. Run the container:
   ```bash
   docker run -p 3000:3000 your-image-name
   ```

## Self-Hosted Options

### Using Nginx
1. Install Nginx on your server.
2. Configure Nginx with your site details:
   ```nginx
   server {
       listen 80;
       server_name your-domain.com;
       location / {
           root /path/to/your/site;
           index index.html;
       }
   }
   ```
3. Restart Nginx:
   ```bash
   sudo systemctl restart nginx
   ```

### Using Apache
1. Install Apache on your server.
2. Configure Apache with your site details:
   ```apache
   <VirtualHost *:80>
       ServerName your-domain.com
       DocumentRoot /path/to/your/site
   </VirtualHost>
   ```
3. Restart Apache:
   ```bash
   sudo systemctl restart apache2
   ```

## Troubleshooting CORS Issues
- Ensure your server includes the right CORS headers:
  - For Node.js, use the `cors` middleware.
  - For Nginx, add `add_header 'Access-Control-Allow-Origin' '*'` to your configuration.

## Performance Tuning Tips
- Minimize HTTP requests by combining CSS/JS files.
- Use a CDN to serve static assets.
- Enable Gzip compression on your web server.
- Optimize images and serve them in next-gen formats.