import { addressOf } from './document.ts';
export const LIBRARY_SOURCE = `#!moss/1
# A few words to graft into another program.
: square dup * ;
: greet "Hello, " swap + "!" + print ;
: weather "The moss predicts a small, excellent rain." print ;
`;

// These are ordinary Moss words. The host has no fern-specific operation.
export const FERN_LIBRARY_SOURCE = `#!moss/1
# A small vocabulary of fronds.
# Change these three marks, then Run again.
: left "╱" ;
: right "╲" ;
: spine "│" ;

# Grow a string by copying and joining it.
: twice dup + ;
: three dup twice + ;
: four twice twice ;
: five dup four + ;

# Each pair of leaflets keeps the spine in the middle.
: one left " " + spine + " " + right + ;
: two left twice "  " + spine + "  " + right twice + ;
: three-leaves left three "   " + spine + "   " + right three + ;
: four-leaves left four "    " + spine + "    " + right four + ;
: five-leaves left five "     " + spine + "     " + right five + ;

# A row takes a frond and its left margin.
: row swap + print ;
: crown "               @" print "               " spine + print ;
: roots "               " spine + print "          · · ·" spine + "· · ·" + print ;

: bud
  crown roots
;
: young
  crown
  one "             " row
  two "           " row
  one "             " row
  roots
;
: fern
  crown
  one "             " row
  two "           " row
  three-leaves "         " row
  four-leaves "       " row
  five-leaves "     " row
  four-leaves "       " row
  three-leaves "         " row
  two "           " row
  one "             " row
  roots
;
`;

export const FERN_VISIT = `# Three small visits to the same fern.
"a little fern" print
"" print
"Name your fern: " input trim
dup "Planting " swap + "." + print
"" print
bud

"Press Enter to wake the first fronds. " input drop
"" print
young

"Press Enter to let it unfurl. " input drop
"" print
fern
"" print
" is here. The morning can take its time." + print
`;

export const FERN_SOURCE = FERN_LIBRARY_SOURCE + '\n' + FERN_VISIT;

export async function demoSources() {
  const libraryAddress = await addressOf(new TextEncoder().encode(LIBRARY_SOURCE));
  const program = `#!moss/1
# A postcard with a library, addressed by its exact bytes.
"${libraryAddress}" graft

"Who is visiting? " input
greet
weather
7 square "Seven squared: " swap str + print
"stressed" reverse print
`;
  const fernLibraryAddress = await addressOf(new TextEncoder().encode(FERN_LIBRARY_SOURCE));
  const fernProgram = `#!moss/1
# The fronds live in a separate source file, pinned by its exact bytes.
"${fernLibraryAddress}" graft

${FERN_VISIT}`;
  return {
    library: LIBRARY_SOURCE, libraryAddress, program,
    programAddress: await addressOf(new TextEncoder().encode(program)),
    fern: FERN_SOURCE, fernLibrary: FERN_LIBRARY_SOURCE, fernLibraryAddress,
    fernProgram, fernProgramAddress: await addressOf(new TextEncoder().encode(fernProgram)),
  };
}
