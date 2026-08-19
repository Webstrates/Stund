#!/bin/bash

# Get the script's directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_FILE="$SCRIPT_DIR/stund/index.html"
BACKUP_FILE="$SCRIPT_DIR/stund/index.html.bak"

if [ ! -f "$TARGET_FILE" ]; then
    echo "Error: $TARGET_FILE not found"
    exit 1
fi

# Create backup
echo "Creating backup: $BACKUP_FILE"
cp "$TARGET_FILE" "$BACKUP_FILE"

# Clean the file
echo "Cleaning file: $TARGET_FILE"
perl -0777 -pi -e '
    # Convert all tag names to lowercase (only actual HTML tags, not text content)
    # Match tags followed by whitespace, >, or /> to ensure they are real tags
    s/<(\/?[A-Za-z][A-Za-z0-9-]*)(\s|>|\/\s*>)/"<" . lc($1) . $2/eg;

    # Remove data-auth and __wid attributes
    s/\sdata-auth(?:\s*=\s*(?:"[^"]*"|'\''[^'\'']*'\''|[^\s>]+))?//g;
    s/\s__wid(?:\s*=\s*(?:"[^"]*"|'\''[^'\'']*'\''|[^\s>]+))?//g;

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
    my $store_body  = body_of("dom-store");
    my $tldraw_body = body_of("tldraw-document");

    # Empty document-, processor- and widget-fragment elements
    s{(<code-folder\b[^>]*\bid="[^"]*document-fragments[^"]*"[^>]*>)$folder_body</code-folder\s*>}{$1</code-folder>}gs;
    s{(<code-folder\b[^>]*\bid="[^"]*processor-fragments[^"]*"[^>]*>)$folder_body</code-folder\s*>}{$1</code-folder>}gs;
    s{(<code-folder\b[^>]*\bid="[^"]*widget-fragments[^"]*"[^>]*>)$folder_body</code-folder\s*>}{$1</code-folder>}gs;

    # Empty dom-store and tldraw data elements
    s{(<dom-store\b[^>]*\bdata-store-id="[^"]*"[^>]*>)$store_body</dom-store\s*>}{$1</dom-store>}gs;
    s{(<code-folder\b[^>]*\bid="[^"]*widget-stores[^"]*"[^>]*>)$folder_body</code-folder\s*>}{$1</code-folder>}gs;
    s{(<tldraw-document\b[^>]*>)$tldraw_body</tldraw-document\s*>}{$1</tldraw-document>}gs;

    # Remove empty id, name, and class attributes
    s/(<[^>]*)\sid\s*=\s*(?:""|'\'''\''|\s+)([^>]*>)/$1$2/g;
    s/(<[^>]*)\sname\s*=\s*(?:""|'\'''\''|\s+)([^>]*>)/$1$2/g;
    s/(<[^>]*)\sclass\s*=\s*(?:""|'\'''\''|\s+)([^>]*>)/$1$2/g;

    # Remove standalone id, name, and class attributes with no value
    s/(<[^>]*)\sid\b(?!\s*=)([^>]*>)/$1$2/g;
    s/(<[^>]*)\sname\b(?!\s*=)([^>]*>)/$1$2/g;
    s/(<[^>]*)\sclass\b(?!\s*=)([^>]*>)/$1$2/g;

    # Change the title tag content to "Stund"
    s|<title>.*?</title>|<title>Stund</title>|s;

    # Sort attributes alphabetically within each tag
    s/<([a-z][a-z0-9-]*)((?:\s+[^>]*?)?)(\s*\/?)>/
        my $tag = $1;
        my $attrs = $2;
        my $close = $3;
        my @attr_list;
        # Extract all attributes (name="value", name='\''value'\'', name=value, or standalone name)
        while ($attrs =~ m{\s+([a-z][a-z0-9-]*)(?:=(?:"([^"]*)"|'\''([^'\'']*)'\''|([^\s>]+)))?}gi) {
            my $name = lc($1);
            my $val = defined $2 ? $2 : (defined $3 ? $3 : $4);
            if (defined $val) {
                push @attr_list, [$name, qq{$name="$val"}];
            } else {
                push @attr_list, [$name, $name];
            }
        }
        my @sorted = sort { $a->[0] cmp $b->[0] } @attr_list;
        my $sorted_attrs = join(" ", map { $_->[1] } @sorted);
        $sorted_attrs = " " . $sorted_attrs if $sorted_attrs;
        "<$tag$sorted_attrs$close>";
    /egsx;
' "$TARGET_FILE"

echo "Done."
