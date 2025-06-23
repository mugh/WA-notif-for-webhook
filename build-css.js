const { execSync } = require('child_process');
const path = require('path');

console.log('Building Tailwind CSS...');

try {
  execSync(
    'npx @tailwindcss/cli -i ./public/css/input.css -o ./public/css/style.css',
    { stdio: 'inherit' }
  );
  console.log('Tailwind CSS built successfully!');
} catch (error) {
  console.error('Error building Tailwind CSS:', error);
  process.exit(1);
} 