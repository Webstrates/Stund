#!/bin/bash

# Get the script's directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_FILE="$SCRIPT_DIR/../prototypes/stund/index.html"
TARGET_FILE="$SCRIPT_DIR/stund.html"

if [ ! -f "$SOURCE_FILE" ]; then
    echo "Error: $SOURCE_FILE not found"
    exit 1
fi

# Copy the file
echo "Copying $SOURCE_FILE to $TARGET_FILE"
cp "$SOURCE_FILE" "$TARGET_FILE"

# Clean the file
echo "Cleaning file: $TARGET_FILE"
perl -0777 -pi -e '
    # Remove the entire <head> element and its contents
    s/<head[^>]*>.*?<\/head>//gs;

    # Matches the body of an element, honouring nesting of that same tag, so
    # that it cannot stop at the closing tag of a nested child of the same kind.
    sub body_of {
        my $tag = quotemeta shift;
        return qr{
            (?<body>
                (?:
                      [^<]+                                 # text
                    | <(?!/?$tag\b)                         # any other tag
                    | <$tag\b[^>]*>(?&body)</$tag\s*>       # nested same-tag element
                )*
            )
        }xs;
    }
    my $folder_body = body_of("code-folder");

    # Remove <code-folder name="Codestrates"> element and its contents
    s{<code-folder\b[^>]*\bname="Codestrates"[^>]*>$folder_body</code-folder\s*>}{}gs;

    # Remove <code-folder name="Meta Elements"> element and its contents.
    # This also takes the widget stores, dom-stores, signaling and tldraw
    # document elements with it, as they all live inside Meta Elements.
    s{<code-folder\b[^>]*\bname="Meta Elements"[^>]*>$folder_body</code-folder\s*>}{}gs;

    # Remove document-, processor- and widget-fragment elements and their contents
    s{<code-folder\b[^>]*\bid="[^"]*document-fragments[^"]*"[^>]*>$folder_body</code-folder\s*>}{}gs;
    s{<code-folder\b[^>]*\bid="[^"]*processor-fragments[^"]*"[^>]*>$folder_body</code-folder\s*>}{}gs;
    s{<code-folder\b[^>]*\bid="[^"]*widget-fragments[^"]*"[^>]*>$folder_body</code-folder\s*>}{}gs;

    # Remove <code-fragment data-type="text/markdown" name="AGENTS/ARCHITECTURE"> element and its contents
    s/<code-fragment\s+data-type="text\/markdown"\s+name="AGENTS"[^>]*>.*?<\/code-fragment>//gs;
    s/<code-fragment\s+data-type="text\/markdown"\s+name="ARCHITECTURE"[^>]*>.*?<\/code-fragment>//gs;
' "$TARGET_FILE"

echo "Output file: $TARGET_FILE"
echo "Done."
