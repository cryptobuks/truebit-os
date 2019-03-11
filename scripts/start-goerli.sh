#!/bin/bash

echo Starting up Parity and IPFS

ipfs daemon  > ~/ipfs_log 2>&1 &

echo plort > supersecret.txt
mkdir -p ~/.local/share/io.parity.ethereum/chains/goerli/
if [ ! -f ~/.local/share/io.parity.ethereum/chains/goerli/myaddress ]
then
    parity --chain goerli --unlock=$(cat goerliparity) --password=supersecret.txt --jsonrpc-cors=all --jsonrpc-interface=all > ~/goerli_log 2>&1 &
fi

sleep 5

echo "Logs should be at ~/goerli_log and ~/ipfs_log"


