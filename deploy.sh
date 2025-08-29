#!/bin/bash

# ChatExo WebRTC Signaling Server Deployment Script
# Run this script on your EC2 instance

set -e

echo "🚀 Starting ChatExo WebRTC Signaling Server deployment..."

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Function to print colored output
print_status() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check if running as root
if [ "$EUID" -eq 0 ]; then
    print_error "Please don't run this script as root"
    exit 1
fi

# Update system packages
print_status "Updating system packages..."
sudo apt update && sudo apt upgrade -y

# Install Docker if not present
if ! command -v docker &> /dev/null; then
    print_status "Installing Docker..."
    curl -fsSL https://get.docker.com -o get-docker.sh
    sudo sh get-docker.sh
    sudo usermod -aG docker $USER
    rm get-docker.sh
    print_warning "Docker installed. You may need to log out and back in for group changes to take effect."
fi

# Install Docker Compose if not present
if ! command -v docker compose &> /dev/null; then
    print_status "Installing Docker Compose..."
    sudo curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
    sudo chmod +x /usr/local/bin/docker-compose
fi

# Create project directory
PROJECT_DIR="$HOME/chatexo-signaling"
print_status "Creating project directory: $PROJECT_DIR"
mkdir -p $PROJECT_DIR
cd $PROJECT_DIR

# Create necessary directories
mkdir -p logs

# Check if .env file exists, create template if not
if [ ! -f ".env" ]; then
    print_warning ".env file not found. Creating template..."
    cat > .env << EOL
# WebRTC Signaling Server Configuration
NODE_ENV=production
PORT=3001
AUTH_TOKEN=$(openssl rand -base64 32)
ALLOWED_ORIGINS=*
JWT_SECRET=$(openssl rand -base64 32)
JWT_REFRESH_SECRET=$(openssl rand -base64 32)
EOL
    print_warning "Please edit .env file with your domain and desired settings before running docker-compose up"
fi

# Configure firewall
print_status "Configuring firewall..."
sudo ufw allow 22/tcp     # SSH
sudo ufw allow 80/tcp     # HTTP
sudo ufw allow 443/tcp    # HTTPS
sudo ufw allow 81/tcp     # Nginx Proxy Manager Admin (you may want to restrict this)
sudo ufw --force enable

# Set proper file permissions
chmod 600 .env
chmod +x deploy.sh

print_status "Deployment preparation complete!"
echo ""
print_status "Next steps:"
echo "1. Edit the .env file with your domain and settings:"
echo "   nano .env"
echo ""
echo "2. Make sure your Docker Compose and Dockerfile are in this directory"
echo ""
echo "3. Start the services:"
echo "   docker-compose up -d"
echo ""
echo "4. Access Nginx Proxy Manager admin panel:"
echo "   http://$(curl -s ifconfig.me):81"
echo "   Default login: admin@example.com / changeme"
echo ""
echo "5. Configure SSL certificates and proxy hosts in NPM admin panel"
echo ""
print_warning "Security reminders:"
echo "- Change all default passwords"
echo "- Configure your domain properly"
echo "- Consider restricting port 81 access after initial setup"
echo "- Keep your system updated"

print_status "🎉 Setup complete! Your server is ready to deploy."