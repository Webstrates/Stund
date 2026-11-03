#!/bin/bash

# Cleans the exported prototype, packages it as a ZIP file, and updates the repository file

set -euo pipefail

# Get the script's directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROTOTYPES_DIR="$SCRIPT_DIR/prototypes"
PROTOTYPE_DIR="$PROTOTYPES_DIR/stund"
PROTOTYPE_ZIP="$PROTOTYPES_DIR/stund.zip"

if ! command -v zip > /dev/null; then
    echo "Error: zip is not installed"
    exit 1
fi

if [ ! -f "$PROTOTYPE_DIR/index.html" ]; then
    echo "Error: $PROTOTYPE_DIR/index.html not found"
    exit 1
fi

# Clean the prototype index.html
echo "== Cleaning prototype"
bash "$PROTOTYPES_DIR/clean-index-html.sh"

# Package the prototype folder contents, leaving out hidden files and backups
echo "== Packaging prototype: $PROTOTYPE_ZIP"
rm -f "$PROTOTYPE_ZIP"
(cd "$PROTOTYPE_DIR" && zip -r -X -q "$PROTOTYPE_ZIP" . -x '.*' '*/.*' '*.bak')
unzip -l "$PROTOTYPE_ZIP"

# Create the repository file from the cleaned prototype
echo "== Updating repository"
bash "$SCRIPT_DIR/repository/clean-repository-html.sh"

echo "== Deployment files updated"
