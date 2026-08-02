tar --exclude='.git' \
    --exclude='node_modules' \
    --exclude='.DS_Store' \
    --exclude='dist' \
    --exclude='bin' \
    --exclude='archive.tar.gz' \
    -czvf archive.tar.gz .
