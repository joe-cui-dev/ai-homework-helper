# Reverify Bedrock Sonnet 5 and Haiku 4.5 prices

Status: needs-triage

In early September 2026, verify the `ap-southeast-2` (`au.` inference profile) input and output token prices for Claude Sonnet 5. The configured Sonnet 5 prices are the observed introductory values, USD 2.20 input and USD 11.00 output per million tokens; they may increase after 2026-08-31. Also obtain an observed (not calculated) Claude Haiku 4.5 geo-profile price before changing its existing constants. Update the CDK price environment variables if verified values differ so Session cost reporting remains accurate.
