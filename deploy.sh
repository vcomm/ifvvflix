echo "The current directory is:"
pwd
echo "The user logged in is:"
whoami

echo "NPM PeerFlix Install"
#echo "Git Clone source update & Checkout to branch"
#sudo git checkout mBrokerIntegration
git clone https://github.com/vcomm/ifvvflix.git
cd peerflix/
npm install && bower install && grunt build
cd ../
echo "NPM PM2 install"
npm i 
echo "Execute Local Proxy Server"
npm start