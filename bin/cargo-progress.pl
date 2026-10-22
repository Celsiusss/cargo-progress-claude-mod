#!/usr/bin/env perl
# Usage: cargo-progress.pl <progress file> cargo [args...]
#
# Runs cargo with its output passed through as it arrives, stdout untouched
# and stderr less the progress bar's frames. The latest frame, or the progress
# of the test binary running now, is written to the progress file for the mod
# to draw. When cargo exits the file holds the results of each cargo the
# command ran so far, one line per kind, tab-separated and led by the
# subcommand: `Tests` once tests ran, `Build` after build, check or clippy or
# after any errors. With none, the file is removed.
use strict;
use warnings;
use IO::Select;
use IPC::Open3;
use Symbol 'gensym';

my $file = shift @ARGV;

my @earlier;
if (open(my $fh, '<', $file)) {
    @earlier = grep { /^(Tests|Build)\t/ } map { s/\n$//r } <$fh>;
    close $fh;
}

my ($passed, $failed, $ignored, $results) = (0, 0, 0, 0);
my (@failures, %failed);
my ($errors, $lint_errors, $warnings, $seconds) = (0, 0, 0, '');
# While reading the body of an error that a note may show to be a lint, its
# message with the backticked names blanked out; '' otherwise.
my $open_error = '';
my %lint_messages;

my ($subcommand) = grep { !/^[-+]/ } @ARGV[1 .. $#ARGV];
$subcommand //= '';
$subcommand = { b => 'build', c => 'check', t => 'test', r => 'run' }->{$subcommand} // $subcommand;
my $built = $subcommand =~ /^(build|check|clippy|rustc|fix)$/;
my $testing = $subcommand =~ /^(test|bench)$/;
# Set once cargo has said `Finished`: what follows is the program's or the
# tests' own output, not the compiler's.
my $compiled = 0;
my $err = gensym;
# open3 closes the handle it hands on; give it a copy so fd 0 stays taken.
my $in;
open($in, '<&', \*STDIN) or open($in, '<', '/dev/null') or die "stdin: $!";
my $pid = open3('<&' . fileno($in), my $out, $err, @ARGV);
binmode $_ for $out, $err, \*STDOUT, \*STDERR;
STDOUT->autoflush(1);
STDERR->autoflush(1);

# Hand interrupts to cargo and keep reading until it has wound down.
$SIG{$_} = sub { kill $_[0], $pid } for qw(INT TERM HUP);

my ($label, $done, $total, $row_start) = ('', 0, 0, 0);

sub frame {
    my ($text) = @_;
    if (open(my $fh, '>', $file)) { print $fh $text; close $fh }
}

sub tests { frame("Testing [] $done/$total" . ($label eq '' ? '' : ": $label")) }

sub err_segment {
    my ($s, $end) = @_;
    if ($end eq "\r") {
        if ($s =~ /^ *((?:\w+ )?\[[=> ]*\].*?) *$/) { frame($1); return }
        return if $s =~ /^ *$/;
    }
    if ($s =~ /^\s+Running (.+?)(?: \(.*\))?\s*$/) { $label = $1 }
    elsif ($s =~ /^\s+Doc-tests (\S+)/) { $label = "doc-tests $1" }
    else { diagnostic($s) }
    print STDERR $s . $end;
}

# Counts rustc's, clippy's and cargo's diagnostics, less cargo's lines that
# sum them up or report a test run's failure. An error whose notes name the
# lint level that denied it (`#[deny(...)]`, `-D warnings`, clippy's
# deny-by-default lints) is a lint error, not a compile error. rustc names the
# level on a lint's first error only, so later errors with the same message,
# backticked names aside, are taken to be the same lint.
sub diagnostic {
    my ($s) = @_;
    return if $compiled;
    if ($s =~ /^\s+Finished .* in (?:(\d+)m )?([\d.]+)s$/) {
        $seconds = ($1 // 0) * 60 + $2;
        $open_error = '';
        $compiled = 1;
        # The build's bar is done; an empty frame takes it down while a
        # program `cargo run` started keeps running.
        frame('');
    }
    elsif ($s =~ /^error: (could not compile|aborting due to|test failed|\d+ targets? failed)/
        || $s =~ /^warning: `[^`]+` \(.*\) generated \d+ warnings?/
        || $s =~ /^warning: build failed, waiting for other jobs/) {
        $open_error = '';
    }
    elsif ($s =~ /^error(?:\[\w+\])?: (.*)$/) {
        my $message = $1 =~ s/`[^`]*`/``/gr;
        if ($lint_messages{$message}) { $lint_errors++; $open_error = '' }
        else { $errors++; $open_error = $message }
    }
    elsif ($s =~ /^warning(\[\w+\])?: /) { $warnings++; $open_error = '' }
    elsif ($open_error ne '' && $s =~ /clippy::|rust-clippy|#!?\[deny\(|`-D [\w:-]+`|lint level is defined here/) {
        $lint_messages{$open_error} = 1;
        $errors--;
        $lint_errors++;
        $open_error = '';
    }
}

sub failure {
    my ($name) = @_;
    push @failures, $name unless $failed{$name}++;
}

# libtest's pretty format prints a line per finished test; the terse one
# (`-q`) a character per test as it finishes, ending each row with a count.
sub out_line {
    my ($line) = @_;
    return unless $testing;
    if ($line =~ /^test (.+?) \.\.\. FAILED$/ || $line =~ /^(\S+) --- FAILED$/) { failure($1) }
    if ($line =~ /^running (\d+) tests?$/) { ($done, $total, $row_start) = (0, $1, 0); tests() if $total }
    elsif ($total && $line =~ /^test \S.* \.\.\.( |$)/) { $done++; $row_start = $done; tests() }
    elsif ($total && $line =~ /^([.Fi]+)(?: \d+\/\d+)?$/) { $done = $row_start + length $1; $row_start = $done; tests() }
    elsif ($line =~ /^test result: \w+\. (\d+) passed; (\d+) failed; (\d+) ignored/) {
        $total = 0;
        $passed += $1;
        $failed += $2;
        $ignored += $3;
        $results = 1;
    }
}

sub out_partial {
    my ($rest) = @_;
    if ($total && $rest =~ /^([.Fi]+)$/ && $row_start + length $1 != $done) {
        $done = $row_start + length $1;
        tests();
    }
}

my ($out_buf, $err_buf) = ('', '');
my $select = IO::Select->new($out, $err);
while ($select->count) {
    for my $fh ($select->can_read) {
        my $n = sysread($fh, my $chunk, 65536);
        if (!defined $n) { next if $!{EINTR}; $select->remove($fh); next }
        if ($n == 0) { $select->remove($fh); next }
        if (fileno($fh) == fileno($out)) {
            print STDOUT $chunk;
            $out_buf .= $chunk;
            out_line($1) while $out_buf =~ s/\A([^\n]*)\n//;
            out_partial($out_buf);
        } else {
            $err_buf .= $chunk;
            err_segment($1, $2) while $err_buf =~ s/\A([^\r\n]*)([\r\n])//;
        }
    }
}
print STDERR $err_buf;

waitpid($pid, 0);
my $status = $?;
my @lines = @earlier;
# A cargo stopped by a signal got only part of the way: no result to report.
my $finished = !($status & 127);
push @lines, join("\t", 'Build', $subcommand, $errors, $lint_errors, $warnings, $seconds)
    if $finished && ($built || $errors || $lint_errors);
push @lines, join("\t", 'Tests', $subcommand, $passed, $failed, $ignored, @failures)
    if $finished && $results;
if (@lines) {
    frame(join "\n", @lines);
} else {
    unlink $file;
}
if ($status & 127) {
    $SIG{$_} = 'DEFAULT' for qw(INT TERM HUP);
    kill $status & 127, $$;
}
exit($status >> 8);
