#!/bin/sh

if [ -n "$MOCK" ]; then
  echo "Mock mode enabled"

  CLUSTER="minecraft"
  SERVICE="minecraft"
  SERVERNAME="minecraft.example.com"
  DNSZONE="mocked-dns-zone"
  ECS_CONTAINER_METADATA_URI_V4="mock://null"

  #function
  aws() {
    if [ "$1" = "ecs" ] && [ "$2" = "update-service" ]; then
      echo "Setting desired task count to zero."
    elif [ "$1" = "ecs" ] && [ "$2" = "describe-tasks" ]; then
      echo '{ "tasks": [{ "attachments": [{ "details": [{ "name": "networkInterfaceId", "value": "eni-mocked-network-id" }] }] }] }'
    elif [ "$1" = "ec2" ] && [ "$2" = "describe-network-interfaces" ]; then
      echo '{ "NetworkInterfaces": [{ "Association": { "PublicIp": "0.0.0.0" } }] }'
    fi
  }

  curl() {
    if [ "$2" = "mock://null/task" ]; then
      echo '{"TaskARN": "arn:aws:ecs:us-west-2:123456789012:task/minecraft/mocked-task-id"}'
    else
      # Forward the request to actual curl
      /usr/bin/curl "$@"
    fi
  }

fi

## Required Environment Variables

[ -n "$CLUSTER" ] || { echo "CLUSTER env variable must be set to the name of the ECS cluster" ; exit 1; }
[ -n "$SERVICE" ] || { echo "SERVICE env variable must be set to the name of the service in the $CLUSTER cluster" ; exit 1; }
[ -n "$SERVERNAME" ] || { echo "SERVERNAME env variable must be set to the full A record in Route53 we are updating" ; exit 1; }
[ -n "$DNSZONE" ] || { echo "DNSZONE env variable must be set to the Route53 Hosted Zone ID" ; exit 1; }

## Optional Environment Variables

[ -n "$STARTUPMIN" ] || { echo "STARTUPMIN env variable not set, defaulting to a 10 minute startup wait" ; STARTUPMIN=10; }
[ -n "$SHUTDOWNMIN" ] || { echo "SHUTDOWNMIN env variable not set, defaulting to a 20 minute shutdown wait" ; SHUTDOWNMIN=20; }
[ -n "$STATSPORT" ] || { echo "STATSPORT env variable not set, defaulting to 57475" ; STATSPORT=57475; }
[ -n "$POLL_FREQ_SECS" ] || { echo "POLL_FREQ_SECS env variable not set, defaulting to 60" ; POLL_FREQ_SECS=60; }

#function
maybe_call_discord_webhooks() {
  if [ -z "$DISCORDWEBHOOKS" ]; then
    echo "No Discord webhook set, skipping Discord notification"
    return
  fi

  MODE="$1"
  REASON="$2"

  DISCORD_JSON=""

  if [ "$MODE" = "startup" ]; then
    DISCORD_JSON="{
      \"content\": null,
      \"embeds\": [
        {
          \"title\": \"🟢 Minecraft Server Started\",
          \"description\": \"Host: \`$SERVERNAME\`\",
          \"color\": null
        }
      ],
      \"attachments\": []
    }"
  elif [ "$MODE" = "shutdown" ]; then
    DISCORD_JSON="{
      \"content\": null,
      \"embeds\": [{
          \"title\": \"🔴 Minecraft Server Stopped\",
          \"description\": \"Shut down because ${REASON}\",
          \"color\": null
      }],
      \"attachments\": []
    }"
  fi

  IFS=','

  for DISCORDWEBHOOK in $DISCORDWEBHOOKS; do
    if [ -n "$DISCORDWEBHOOK" ]; then
      echo "Discord webhook set, sending $1 message"
      curl --silent -X POST -H "Content-Type: application/json" -d "$DISCORD_JSON" "$DISCORDWEBHOOK"
    fi
  done

  unset IFS # Restore the default IFS
}

#function
get_simple_notif_message() {
  MODE="$1"
  REASON="$2"

  MESSAGETEXT=""
  if [ "$MODE" = "startup" ]; then
    MESSAGETEXT="Minecraft server is online at ${SERVERNAME}"
  elif [ "$MODE" = "shutdown" ]; then
    MESSAGETEXT="Shutting down ${SERVICE} at ${SERVERNAME}"
  fi

  echo "$MESSAGETEXT"
}

#function
maybe_send_twilio_notifs() {
  if [ -z "$TWILIOFROM" ] || [ -z "$TWILIOTO" ] || [ -z "$TWILIOAID" ] || [ -z "$TWILIOAUTH" ]; then
    echo "Twilio information not set, skipping Twilio notification"
    return
  fi

  MODE="$1"
  REASON="$2"

  MESSAGETEXT=$(get_simple_notif_message "$MODE" "$REASON")

  echo "Twilio information set, sending $MODE message"
  curl --silent -XPOST -d "Body=$MESSAGETEXT" -d "From=$TWILIOFROM" -d "To=$TWILIOTO" "https://api.twilio.com/2010-04-01/Accounts/$TWILIOAID/Messages" -u "$TWILIOAID:$TWILIOAUTH"
}

#function
maybe_publish_sns_topic() {
  if [ -z "$SNSTOPIC" ]; then
    echo "SNS topic not set, skipping SNS notification"
    return
  fi

  MODE="$1"
  REASON="$2"

  MESSAGETEXT=$(get_simple_notif_message "$MODE" "$REASON")

  echo "SNS topic set, sending $MODE message"
  aws sns publish --topic-arn "$SNSTOPIC" --message "$MESSAGETEXT"
}

#function
send_notifications() {
  MODE="$1"
  REASON="$2"

  maybe_call_discord_webhooks "$MODE" "$REASON"
  maybe_send_twilio_notifs "$MODE" "$REASON"
  maybe_publish_sns_topic "$MODE" "$REASON"
}

zero_service_and_exit() {
  REASON="$1"
  send_notifications shutdown "$REASON"
  echo Setting desired task count to zero.
  aws ecs update-service --cluster "$CLUSTER" --service "$SERVICE" --desired-count 0
  exit 0
}

#function
get_active_connection_count() {
  curl --silent -m 10 "http://localhost:$STATSPORT"
}

#function
is_valid_connection_value() {
  # if [[ $1 =~ ^[0-9]+$ ]]; then
  #   return 0
  # else
  #   return 1
  # fi

  # Check if the value is a number in POSIX compliant way
  case $1 in
    ''|*[!0-9]*) return 1 ;;
    *) return 0 ;;
  esac
}

#function
wait_for_next_poll() {
  ## Sleep in increments of 1s so that we can catch a SIGTERM if needed

  SLEEPLOOP=0
  while [ $SLEEPLOOP -lt "$POLL_FREQ_SECS" ]; do
    sleep 1
    SLEEPLOOP=$((SLEEPLOOP + 1))
  done
}

#function
get_task() {
  curl -s "${ECS_CONTAINER_METADATA_URI_V4}/task" | jq -r '.TaskARN' | awk -F/ '{ print $NF }'
}

#function
get_minute_of_poll() {
  # Given a poll count and poll frequency, return the minute of the poll
  # rounded down to the nearest minute
  POLL_COUNT="$1"
  POLL_FREQ_SECS="$2"

  echo "$((POLL_COUNT * POLL_FREQ_SECS / 60))"


}

#shellcheck disable=SC2317 # Only applies to this function
#function
sigterm() {
  ## upon SIGTERM set the service desired count to zero
  echo "Received SIGTERM, terminating task..."
  zero_service_and_exit "SIGTERM received"
}

trap sigterm TERM

## get task id from the Fargate metadata
TASK=$(get_task)
echo "I believe our task id is $TASK"

## get eni from from ECS
ENI=$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK" --query "tasks[0].attachments[0].details[?name=='networkInterfaceId'].value | [0]" --output text)
echo "I believe our eni is $ENI"

## get public ip address from EC2
PUBLICIP=$(aws ec2 describe-network-interfaces --network-interface-ids "$ENI" --query 'NetworkInterfaces[0].Association.PublicIp' --output text)
echo "I believe our public IP address is $PUBLICIP"

## update public dns record
echo "Updating DNS record for $SERVERNAME to $PUBLICIP"
## prepare json file
cat << EOF >> minecraft-dns.json
{
  "Comment": "Fargate Public IP change for Minecraft Server",
  "Changes": [
    {
      "Action": "UPSERT",
      "ResourceRecordSet": {
        "Name": "$SERVERNAME",
        "Type": "A",
        "TTL": 30,
        "ResourceRecords": [
          {
            "Value": "$PUBLICIP"
          }
        ]
      }
    }
  ]
}
EOF

aws route53 change-resource-record-sets --hosted-zone-id "$DNSZONE" --change-batch file://minecraft-dns.json

echo "Waiting up to 10 minutes to detect Minecraft WatchPup output..."

POLL_COUNT=0
while true; do
  PLAYERS_CONNECTED=$(get_active_connection_count)

  if (is_valid_connection_value "$PLAYERS_CONNECTED"); then
    echo "WatchPup plugin is responding to queries, continuing with monitoring..."
    break
  fi

  sleep 1
  POLL_COUNT=$((POLL_COUNT + 1))
  if [ $POLL_COUNT -gt 600 ]; then ## server has not been detected as starting within 10 minutes
    echo "Failed to contact WatchPup for 10 minutes straight, terminating."
    zero_service_and_exit "the server was never detected as having started"
  fi
done

## Send startup notification message
send_notifications startup

echo "Checking WatchPup every $POLL_FREQ_SECS seconds for active connections to Minecraft, up to $STARTUPMIN minutes..."

MAX_POLL_COUNT=$((STARTUPMIN * 60 / POLL_FREQ_SECS))
POLL_COUNT=0

PLAYERS_CONNECTED=0
while [ "$PLAYERS_CONNECTED" -lt 1 ]; do
  CURRENT_MINUTE=$(get_minute_of_poll "$POLL_COUNT" "$POLL_FREQ_SECS")
  echo "Waiting for connection, poll $POLL_COUNT / $MAX_POLL_COUNT, minute $CURRENT_MINUTE / $STARTUPMIN..."

  PLAYERS_CONNECTED=$(get_active_connection_count)
  POLL_COUNT=$((POLL_COUNT + 1))
  if [ "$PLAYERS_CONNECTED" -gt 0 ]; then ## at least one active connection detected, break out of loop
    break
  fi

  if [ $POLL_COUNT -gt "$MAX_POLL_COUNT" ]; then ## no one has connected in at least these many minutes
    echo "$STARTUPMIN minutes exceeded without a connection, terminating."
    zero_service_and_exit "no initial connection was detected in $STARTUPMIN minutes"
  fi

  wait_for_next_poll
done

echo "Connection detected, switching to shutdown watcher."

MAX_POLL_COUNT=$((SHUTDOWNMIN * 60 / POLL_FREQ_SECS))
POLL_COUNT=0

while [ $POLL_COUNT -le "$MAX_POLL_COUNT" ]; do
  CURRENT_MINUTE=$(get_minute_of_poll "$POLL_COUNT" "$POLL_FREQ_SECS")
  PLAYERS_CONNECTED=$(get_active_connection_count)

  if ! is_valid_connection_value "$PLAYERS_CONNECTED"; then
    PLAYERS_CONNECTED=0
  fi

  if [ "$PLAYERS_CONNECTED" -lt 1 ]; then
    echo "No active connections detected, poll $POLL_COUNT / $MAX_POLL_COUNT, minute $CURRENT_MINUTE / $SHUTDOWNMIN..."
    POLL_COUNT=$((POLL_COUNT + 1))
  else
    [ $POLL_COUNT -gt 0 ] && echo "New connections active, zeroing counter."
    POLL_COUNT=0
  fi

  wait_for_next_poll
done


echo "$SHUTDOWNMIN minutes elapsed without a connection, terminating."
zero_service_and_exit "no connections were detected for $SHUTDOWNMIN minutes"
